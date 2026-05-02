import * as path from 'node:path';
import * as vscode from 'vscode';

import type { AvatarCache } from '../avatars/avatarCache';
import type { GitService } from '../git/gitService';
import { activeTargetFromEditor } from '../git/gitUri';
import { debounce } from '../util/debounce';
import {
  buildCommitTooltip,
  parseDiffStat,
  relativeTime,
  type CommitInfo,
} from '../util/format';

const PAGE_SIZE = 50;

interface CommitNode {
  kind: 'commit';
  commit: CommitInfo;
  hasParent: boolean;
  fileUri: vscode.Uri;
}

interface LoadMoreNode {
  kind: 'loadMore';
}

interface MessageNode {
  kind: 'message';
  text: string;
}

interface LoadingNode {
  kind: 'loading';
}

type FileHistoryNode = CommitNode | LoadMoreNode | MessageNode | LoadingNode;

export class FileHistoryProvider
  implements vscode.TreeDataProvider<FileHistoryNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    FileHistoryNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];

  private currentFileUri: vscode.Uri | undefined;
  private currentRef: string | undefined;
  private commits: CommitNode[] = [];
  private loading = false;
  private hasMore = false;
  private errorMessage: string | undefined;
  private queryAbort: AbortController | undefined;
  private queryKey: string | undefined;

  private readonly fireSoon = debounce(
    () => this._onDidChangeTreeData.fire(),
    80,
  );

  constructor(
    private readonly git: GitService,
    private readonly avatars: AvatarCache,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.onFileChanged()),
      this.git.onDidChangeActiveRepo(() => this.onFileChanged()),
      this.git.onDidChangeActiveRepoState(() => this.onFileChanged()),
      this.avatars.onDidCacheAvatar(() => this._onDidChangeTreeData.fire()),
    );
    this.onFileChanged();
  }

  refresh(): void {
    this.onFileChanged();
  }

  loadMore(): void {
    if (this.loading || !this.hasMore || this.commits.length === 0) return;
    const lastSha = this.commits[this.commits.length - 1].commit.hash;
    void this.startQuery({ beforeSha: lastSha, append: true });
  }

  private onFileChanged(): void {
    const target = activeTargetFromEditor(vscode.window.activeTextEditor);
    const repo = this.git.activeRepo;
    const key = `${repo?.rootUri.fsPath ?? ''}::${target?.fileUri.fsPath ?? ''}::${target?.ref ?? ''}`;
    if (key === this.queryKey) return;

    // If we have no meaningful target (no editor, unsupported scheme, etc.) and we
    // already had a previous target, keep showing the last result instead of clearing.
    // This is what makes the view remain populated while the user navigates around a
    // commit diff or inspects output panes.
    if (!target && this.currentFileUri) return;

    this.queryKey = key;
    this.queryAbort?.abort();
    this.queryAbort = undefined;
    this.currentFileUri = target?.fileUri;
    this.currentRef = target?.ref;
    this.commits = [];
    this.hasMore = false;
    this.errorMessage = undefined;

    if (!repo || !target) {
      this.loading = false;
      this._onDidChangeTreeData.fire();
      return;
    }
    void this.startQuery({ append: false });
  }

  private async startQuery(opts: {
    beforeSha?: string;
    append: boolean;
  }): Promise<void> {
    const repo = this.git.activeRepo;
    const fileUri = this.currentFileUri;
    if (!repo || !fileUri) return;

    const relPath = path.relative(repo.rootUri.fsPath, fileUri.fsPath);
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
      this.commits = [];
      this.errorMessage = 'File is outside the active repository.';
      this.loading = false;
      this._onDidChangeTreeData.fire();
      return;
    }

    this.queryAbort?.abort();
    const abort = new AbortController();
    this.queryAbort = abort;

    if (!opts.append) this.commits = [];
    this.loading = true;
    this.errorMessage = undefined;
    this.hasMore = false;
    this._onDidChangeTreeData.fire();

    const US = '\x1f';
    const RS = '\x1e';
    const fmt = ['%H', '%s', '%b', '%aN', '%aE', '%aI', '%P'].join(US) + RS;
    const args: string[] = [
      'log',
      '--follow',
      `-n`,
      `${PAGE_SIZE}`,
      `--format=${fmt}`,
    ];
    // Start rev: Load more takes precedence (walk from parent of last shown commit).
    // Otherwise, when we're viewing a diff editor we use that diff's ref so the open
    // commit sits at the top of the list. Otherwise HEAD (implicit).
    if (opts.beforeSha) {
      args.push(`${opts.beforeSha}^`);
    } else if (this.currentRef) {
      args.push(this.currentRef);
    }
    args.push('--', relPath);

    const startCount = this.commits.length;
    try {
      await this.git.streamGit(
        args,
        (rec) => {
          if (abort.signal.aborted) return;
          const node = parseCommitRecord(rec, US, fileUri);
          if (node) {
            this.commits.push(node);
            this.fireSoon();
          }
        },
        { cwd: repo.rootUri.fsPath, signal: abort.signal },
      );
    } catch (err) {
      if (!abort.signal.aborted) {
        this.errorMessage = err instanceof Error ? err.message : String(err);
      }
    }

    if (abort.signal.aborted) return;
    this.loading = false;
    const added = this.commits.length - startCount;
    this.hasMore = added >= PAGE_SIZE;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: FileHistoryNode): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(
        node.text,
        vscode.TreeItemCollapsibleState.None,
      );
      item.contextValue = 'message';
      return item;
    }
    if (node.kind === 'loading') {
      const item = new vscode.TreeItem(
        'Loading...',
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      item.contextValue = 'loading';
      return item;
    }
    if (node.kind === 'loadMore') {
      const item = new vscode.TreeItem(
        'Load more...',
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon('chevron-down');
      item.contextValue = 'loadMore';
      item.command = {
        command: 'recall.fileHistory.loadMore',
        title: 'Load More',
      };
      return item;
    }
    const c = node.commit;
    const item = new vscode.TreeItem(
      c.subject,
      vscode.TreeItemCollapsibleState.None,
    );
    const descParts: string[] = [];
    if (c.authorName) descParts.push(c.authorName);
    if (c.authorDate) descParts.push(relativeTime(c.authorDate));
    item.description = descParts.join(' · ');
    const avatar = this.avatars.get(c.authorEmail, c.authorName);
    item.iconPath = avatar.iconUri;
    item.tooltip = buildCommitTooltip(c, {
      avatarDataUri: avatar.dataUri,
      remote: this.git.remoteInfo,
      truncateBody: true,
    });
    item.contextValue = 'fileCommit';
    item.id = `fh-${c.hash}`;
    item.command = {
      command: 'recall.openFileDiff',
      title: 'Open File Diff',
      arguments: [
        { sha: c.hash, fileUri: node.fileUri, hasParent: node.hasParent },
      ],
    };
    return item;
  }

  async resolveTreeItem(
    item: vscode.TreeItem,
    node: FileHistoryNode,
  ): Promise<vscode.TreeItem> {
    if (node.kind !== 'commit') return item;
    try {
      const raw = await this.git.runGit([
        'show',
        '--format=',
        '--shortstat',
        node.commit.hash,
      ]);
      const diffStat = parseDiffStat(raw.trim());
      if (diffStat) {
        const avatar = this.avatars.get(
          node.commit.authorEmail,
          node.commit.authorName,
        );
        item.tooltip = buildCommitTooltip(node.commit, {
          avatarDataUri: avatar.dataUri,
          remote: this.git.remoteInfo,
          diffStat,
          truncateBody: true,
        });
      }
    } catch {
      /* keep existing tooltip */
    }
    return item;
  }

  getChildren(parent?: FileHistoryNode): FileHistoryNode[] {
    if (parent) return [];
    const repo = this.git.activeRepo;
    if (!repo)
      return [{ kind: 'message', text: 'No Git repository detected.' }];
    if (!this.currentFileUri)
      return [{ kind: 'message', text: 'Open a file to see its history.' }];

    const out: FileHistoryNode[] = [...this.commits];
    if (this.loading) out.push({ kind: 'loading' });
    else if (this.errorMessage)
      out.push({ kind: 'message', text: `Error: ${this.errorMessage}` });
    else if (this.hasMore) out.push({ kind: 'loadMore' });
    else if (this.commits.length === 0)
      out.push({ kind: 'message', text: 'No history for this file.' });
    return out;
  }

  dispose(): void {
    this.queryAbort?.abort();
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function parseCommitRecord(
  rec: string,
  US: string,
  fileUri: vscode.Uri,
): CommitNode | undefined {
  const [hash, subject, body, authorName, authorEmail, authorISO, parents] =
    rec.split(US);
  if (!hash || !subject) return undefined;
  const info: CommitInfo = {
    hash,
    subject,
    body: body ?? '',
    authorName: authorName || undefined,
    authorEmail: authorEmail || undefined,
    authorDate: authorISO ? new Date(authorISO) : undefined,
  };
  const hasParent = (parents ?? '').trim().length > 0;
  return { kind: 'commit', commit: info, hasParent, fileUri };
}
