import * as vscode from 'vscode';

import type { GitService } from '../git/gitService';
import { parseDiffStat, type DiffStat } from '../util/format';

export interface BlameLineInfo {
  sha: string;
  authorName: string;
  authorEmail: string;
  authorDate: Date;
  summary: string;
}

export type BlameData = Map<number, BlameLineInfo>;

const UNCOMMITTED_SHA = '0'.repeat(40);

export function isUncommitted(info: BlameLineInfo): boolean {
  return info.sha === UNCOMMITTED_SHA;
}

interface CacheEntry {
  data: BlameData;
  version: number;
}

export class BlameService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<BlameData | undefined>>();
  private readonly messageCache = new Map<
    string,
    { body: string; stat: DiffStat | undefined }
  >();
  private userEmail: string | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly git: GitService) {
    this.disposables.push(
      this._onDidChange,
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.cache.delete(doc.uri.fsPath);
        this._onDidChange.fire();
      }),
      this.git.onDidChangeActiveRepoState(() => {
        this.cache.clear();
        this.messageCache.clear();
        this._onDidChange.fire();
      }),
      this.git.onDidChangeActiveRepo(() => {
        this.cache.clear();
        this.messageCache.clear();
        void this.resolveUserEmail();
        this._onDidChange.fire();
      }),
    );
    void this.resolveUserEmail();
  }

  async getBlame(
    document: vscode.TextDocument,
  ): Promise<BlameData | undefined> {
    if (document.uri.scheme !== 'file') return undefined;
    if (document.isDirty) return undefined;

    const repo = this.git.activeRepo;
    if (!repo) return undefined;

    const fsPath = document.uri.fsPath;
    if (!fsPath.startsWith(repo.rootUri.fsPath)) return undefined;

    const cached = this.cache.get(fsPath);
    if (cached && cached.version === document.version) return cached.data;

    const inflight = this.pending.get(fsPath);
    if (inflight) return inflight;

    const promise = this.runBlame(document);
    this.pending.set(fsPath, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(fsPath);
    }
  }

  async getLineBlame(
    document: vscode.TextDocument,
    line: number,
  ): Promise<BlameLineInfo | undefined> {
    const data = await this.getBlame(document);
    return data?.get(line);
  }

  async getCommitBody(sha: string): Promise<string> {
    const cached = this.messageCache.get(sha);
    if (cached !== undefined) return cached.body;
    await this.fetchCommitDetails(sha);
    return this.messageCache.get(sha)?.body ?? '';
  }

  async getCommitStat(sha: string): Promise<DiffStat | undefined> {
    const cached = this.messageCache.get(sha);
    if (cached !== undefined) return cached.stat;
    await this.fetchCommitDetails(sha);
    return this.messageCache.get(sha)?.stat;
  }

  private async fetchCommitDetails(sha: string): Promise<void> {
    if (this.messageCache.has(sha)) return;
    try {
      const raw = await this.git.runGit([
        'show',
        '--format=%b',
        '--shortstat',
        sha,
      ]);
      const parts = raw.split('\n\n');
      const statLine = parts.pop()?.trim() ?? '';
      const body = parts.join('\n\n').trim();
      const stat = parseDiffStat(statLine);
      this.messageCache.set(sha, { body, stat });
    } catch {
      this.messageCache.set(sha, { body: '', stat: undefined });
    }
  }

  isCurrentUser(email: string): boolean {
    return (
      this.userEmail !== undefined && email.toLowerCase() === this.userEmail
    );
  }

  private async resolveUserEmail(): Promise<void> {
    try {
      const raw = await this.git.runGit(['config', 'user.email']);
      this.userEmail = raw.trim().toLowerCase();
    } catch {
      this.userEmail = undefined;
    }
  }

  private async runBlame(
    document: vscode.TextDocument,
  ): Promise<BlameData | undefined> {
    const repo = this.git.activeRepo;
    if (!repo) return undefined;

    const cwd = repo.rootUri.fsPath;
    const relPath = vscode.workspace.asRelativePath(document.uri, false);

    try {
      const raw = await this.git.runGit(
        ['blame', '--porcelain', '--', relPath],
        { cwd },
      );
      const data = parsePorcelainBlame(raw);
      this.cache.set(document.uri.fsPath, {
        data,
        version: document.version,
      });
      return data;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function parsePorcelainBlame(raw: string): BlameData {
  const lines = raw.split('\n');
  const commits = new Map<
    string,
    {
      authorName: string;
      authorEmail: string;
      authorDate: Date;
      summary: string;
    }
  >();
  const result: BlameData = new Map();
  let i = 0;

  while (i < lines.length) {
    const headerMatch = /^([0-9a-f]{40}) \d+ (\d+)/.exec(lines[i]);
    if (!headerMatch) {
      i++;
      continue;
    }

    const sha = headerMatch[1];
    const finalLine = parseInt(headerMatch[2], 10) - 1;
    i++;

    if (!commits.has(sha)) {
      let authorName = '';
      let authorEmail = '';
      let authorTime = 0;
      let summary = '';

      while (i < lines.length && !lines[i].startsWith('\t')) {
        const line = lines[i];
        if (line.startsWith('author ')) authorName = line.slice(7);
        else if (line.startsWith('author-mail '))
          authorEmail = line.slice(12).replace(/^<|>$/g, '');
        else if (line.startsWith('author-time '))
          authorTime = parseInt(line.slice(12), 10);
        else if (line.startsWith('summary ')) summary = line.slice(8);
        i++;
      }

      commits.set(sha, {
        authorName,
        authorEmail,
        authorDate: new Date(authorTime * 1000),
        summary,
      });
    } else {
      while (i < lines.length && !lines[i].startsWith('\t')) i++;
    }

    if (i < lines.length && lines[i].startsWith('\t')) i++;

    const info = commits.get(sha)!;
    result.set(finalLine, { sha, ...info });
  }

  return result;
}
