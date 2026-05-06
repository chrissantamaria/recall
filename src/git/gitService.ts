import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

import type { API as GitAPI, GitExtension, Repository } from './git';
import { parseRemoteUrl, type CustomRemotes, type RemoteInfo } from './remote';

export class GitService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChangeActiveRepo = new vscode.EventEmitter<
    Repository | undefined
  >();
  readonly onDidChangeActiveRepo = this._onDidChangeActiveRepo.event;

  private _api: GitAPI | undefined;
  private _activeRepo: Repository | undefined;
  private _activeRepoStateListener: vscode.Disposable | undefined;

  private readonly _onDidChangeActiveRepoState =
    new vscode.EventEmitter<void>();
  readonly onDidChangeActiveRepoState = this._onDidChangeActiveRepoState.event;

  async initialize(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) {
      void vscode.window.showErrorMessage(
        'Backpocket: the built-in Git extension is not available.',
      );
      return;
    }
    if (!ext.isActive) {
      await ext.activate();
    }
    const gitExt = ext.exports;
    if (!gitExt.enabled) {
      const waitEnabled = new Promise<void>((resolve) => {
        const d = gitExt.onDidChangeEnablement((enabled) => {
          if (enabled) {
            d.dispose();
            resolve();
          }
        });
        this.disposables.push(d);
      });
      await waitEnabled;
    }
    this._api = gitExt.getAPI(1);

    if (this._api.state !== 'initialized') {
      await new Promise<void>((resolve) => {
        const d = this._api!.onDidChangeState((s) => {
          if (s === 'initialized') {
            d.dispose();
            resolve();
          }
        });
        this.disposables.push(d);
      });
    }

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshActiveRepo()),
      this._api.onDidOpenRepository(() => this.refreshActiveRepo()),
      this._api.onDidCloseRepository(() => this.refreshActiveRepo()),
    );

    this.refreshActiveRepo();
  }

  get api(): GitAPI | undefined {
    return this._api;
  }

  get activeRepo(): Repository | undefined {
    return this._activeRepo;
  }

  /**
   * Best-effort web-host info for the active repo. Prefers `upstream` then `origin`
   * then the first available remote. Returns undefined if none can be parsed as a
   * known host (GitHub / GitLab / Bitbucket).
   */
  get remoteInfo(): RemoteInfo | undefined {
    const repo = this._activeRepo;
    if (!repo) return undefined;
    const remotes = repo.state.remotes ?? [];
    if (remotes.length === 0) return undefined;
    const byName = (name: string) => remotes.find((r) => r.name === name);
    const picked = byName('upstream') ?? byName('origin') ?? remotes[0];
    const url = picked.fetchUrl ?? picked.pushUrl;
    if (!url) return undefined;
    const customRemotes =
      vscode.workspace
        .getConfiguration('backpocket')
        .get<CustomRemotes>('remotes') ?? {};
    return parseRemoteUrl(url, customRemotes);
  }

  private refreshActiveRepo(): void {
    if (!this._api) return;
    const editor = vscode.window.activeTextEditor;
    let next: Repository | undefined;
    if (editor) {
      next = this._api.getRepository(editor.document.uri) ?? undefined;
    }
    if (!next && this._api.repositories.length > 0) {
      next = this._api.repositories[0];
    }
    if (next === this._activeRepo) return;

    this._activeRepoStateListener?.dispose();
    this._activeRepoStateListener = undefined;
    this._activeRepo = next;
    if (next) {
      this._activeRepoStateListener = next.state.onDidChange(() => {
        this._onDidChangeActiveRepoState.fire();
      });
    }
    this._onDidChangeActiveRepo.fire(next);
  }

  async runGit(args: string[], opts?: { cwd?: string }): Promise<string> {
    if (!this._api) throw new Error('Git API not initialized');
    const cwd = opts?.cwd ?? this._activeRepo?.rootUri.fsPath;
    if (!cwd) throw new Error('No active repository');
    const binary = this._api.git.path;
    return new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(out).toString('utf8'));
        } else {
          reject(
            new Error(
              `git ${args.join(' ')} exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`,
            ),
          );
        }
      });
    });
  }

  /**
   * Stream records from git. Each record is separated by `recordSeparator` (default \x1e).
   * `onRecord` is called synchronously for every completed record as stdout arrives.
   * Returns a promise that resolves when git exits cleanly, rejects on failure.
   * If `signal` is aborted, the child is killed and the promise resolves silently.
   */
  streamGit(
    args: string[],
    onRecord: (rec: string) => void,
    opts?: { cwd?: string; signal?: AbortSignal; recordSeparator?: string },
  ): Promise<void> {
    if (!this._api) return Promise.reject(new Error('Git API not initialized'));
    const cwd = opts?.cwd ?? this._activeRepo?.rootUri.fsPath;
    if (!cwd) return Promise.reject(new Error('No active repository'));
    const binary = this._api.git.path;
    const sep = opts?.recordSeparator ?? '\x1e';

    return new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
      const stderrChunks: Buffer[] = [];
      let buf = '';
      let aborted = false;

      const onAbort = () => {
        aborted = true;
        try {
          child.kill();
        } catch {
          /* noop */
        }
      };
      if (opts?.signal) {
        if (opts.signal.aborted) {
          onAbort();
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf(sep)) !== -1) {
          const rec = buf.slice(0, idx).trim();
          buf = buf.slice(idx + sep.length);
          if (rec.length > 0) {
            try {
              onRecord(rec);
            } catch {
              /* swallow; streaming must continue */
            }
          }
        }
      });
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk as Buffer));
      child.on('error', (err) => {
        opts?.signal?.removeEventListener('abort', onAbort);
        if (aborted) resolve();
        else reject(err);
      });
      child.on('close', (code) => {
        opts?.signal?.removeEventListener('abort', onAbort);
        if (aborted) {
          resolve();
          return;
        }
        if (code === 0) {
          const tail = buf.trim();
          if (tail.length > 0) {
            try {
              onRecord(tail);
            } catch {
              /* noop */
            }
          }
          resolve();
        } else {
          const msg = Buffer.concat(stderrChunks).toString('utf8').trim();
          reject(new Error(`git ${args.join(' ')} exited ${code}: ${msg}`));
        }
      });
    });
  }

  dispose(): void {
    this._activeRepoStateListener?.dispose();
    this._onDidChangeActiveRepo.dispose();
    this._onDidChangeActiveRepoState.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
