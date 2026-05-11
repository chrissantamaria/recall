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

const PAGE_SIZE = 25;

interface CommitNode {
  kind: 'commit';
  commit: CommitInfo;
  hasParent: boolean;
  fileUri: vscode.Uri;
}

interface MessageNode {
  kind: 'message';
  text: string;
}

interface LoadMoreNode {
  kind: 'loadMore';
}

interface LoadingNode {
  kind: 'loading';
}

type LineHistoryNode = CommitNode | MessageNode | LoadMoreNode | LoadingNode;

export class LineHistoryProvider
  implements vscode.TreeDataProvider<LineHistoryNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    LineHistoryNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];

  private currentFileUri: vscode.Uri | undefined;
  private currentRef: string | undefined;
  /** Rev passed to `git log -L` as the walk tip (for diff paths). */
  private logTipRef = 'HEAD';
  private currentRange: { start: number; end: number } | undefined;
  private queryKey: string | undefined;
  private pages = 1;

  private commits: CommitNode[] = [];
  private loading = false;
  private hasMore = false;
  private errorMessage: string | undefined;
  private queryAbort: AbortController | undefined;

  private readonly fireSoon = debounce(
    () => this._onDidChangeTreeData.fire(),
    80,
  );

  constructor(
    private readonly git: GitService,
    private readonly avatars: AvatarCache,
  ) {
    const debouncedSelection = debounce(() => this.onSelectionChanged(), 250);
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() =>
        this.onSelectionChanged(),
      ),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor)
          debouncedSelection();
      }),
      this.git.onDidChangeActiveRepo(() => this.onSelectionChanged()),
      this.git.onDidChangeActiveRepoState(() => this.onSelectionChanged()),
      this.avatars.onDidCacheAvatar(() => this._onDidChangeTreeData.fire()),
    );
    this.onSelectionChanged();
  }

  refresh(): void {
    this.queryKey = undefined;
    this.onSelectionChanged();
  }

  loadMore(): void {
    if (this.loading || !this.hasMore) return;
    this.pages += 1;
    void this.startQuery({ append: true });
  }

  private onSelectionChanged(): void {
    const editor = vscode.window.activeTextEditor;
    const target = activeTargetFromEditor(editor);
    let range: { start: number; end: number } | undefined;
    if (editor && target) {
      const sel = editor.selection;
      const start = Math.min(sel.start.line, sel.end.line) + 1;
      const end = Math.max(sel.start.line, sel.end.line) + 1;
      range = { start, end };
    }
    const repo = this.git.activeRepo;
    const key = `${repo?.rootUri.fsPath ?? ''}::${target?.fileUri.fsPath ?? ''}::${target?.ref ?? ''}::${range?.start ?? 0}-${range?.end ?? 0}`;
    if (key === this.queryKey) return;

    // If we lost the target (focus moved to a pane with no usable URI), keep what we
    // have rather than blanking the view. Same motivation as FileHistoryProvider.
    if (!target && this.currentFileUri) return;

    this.queryKey = key;
    this.queryAbort?.abort();
    this.queryAbort = undefined;
    this.currentFileUri = target?.fileUri;
    this.currentRef = target?.ref;
    this.currentRange = range;
    this.commits = [];
    this.hasMore = false;
    this.errorMessage = undefined;
    this.pages = 1;

    if (!repo || !target || !range) {
      this.loading = false;
      this._onDidChangeTreeData.fire();
      return;
    }
    void this.startQuery({ append: false });
  }

  private async startQuery(opts: { append: boolean }): Promise<void> {
    const repo = this.git.activeRepo;
    const fileUri = this.currentFileUri;
    const range = this.currentRange;
    if (!repo || !fileUri || !range) return;

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

    if (!opts.append) {
      this.logTipRef = this.currentRef ?? 'HEAD';
    }

    const limit = PAGE_SIZE * this.pages;
    const US = '\x1f';
    const RS = '\x1e';
    const fmt = ['%H', '%s', '%b', '%aN', '%aE', '%aI', '%P'].join(US) + RS;
    const args = [
      'log',
      `-L${range.start},${range.end}:${relPath}`,
      '--no-patch',
      '-n',
      `${limit}`,
      `--format=${fmt}`,
    ];
    // When invoked on a diff editor, ref points to the version of the file the user is
    // looking at. Passing it as the starting rev makes git interpret the line range
    // against that version and walk backwards - which is what we want for selecting
    // lines on either pane of a commit diff.
    if (this.currentRef) args.push(this.currentRef);

    this.loading = true;
    this.errorMessage = undefined;
    this.hasMore = false;
    // On initial load, clear so user sees progress fill live.
    // On Load More, keep existing and swap in once we exceed the existing count.
    if (!opts.append) this.commits = [];
    this._onDidChangeTreeData.fire();

    const collected: CommitNode[] = [];
    try {
      await this.git.streamGit(
        args,
        (rec) => {
          if (abort.signal.aborted) return;
          const node = parseCommitRecord(rec, US, fileUri);
          if (!node) return;
          collected.push(node);
          if (!opts.append) {
            this.commits = collected.slice();
            this.fireSoon();
          } else if (collected.length > this.commits.length) {
            this.commits = collected.slice();
            this.fireSoon();
          }
        },
        { cwd: repo.rootUri.fsPath, signal: abort.signal },
      );
    } catch (err) {
      if (!abort.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          /there is no tracked file at that path|no such path in the working tree/i.test(
            msg,
          )
        ) {
          this.errorMessage = 'File is not tracked in this repository.';
        } else {
          this.errorMessage = msg;
        }
      }
    }

    if (abort.signal.aborted) return;
    this.commits = collected;
    this.loading = false;
    this.hasMore = collected.length >= limit;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: LineHistoryNode): vscode.TreeItem {
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
        command: 'backpocket.lineHistory.loadMore',
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
    item.contextValue = 'lineCommit';
    item.id = `lh-${c.hash}`;
    item.command = {
      command: 'backpocket.openFileDiff',
      title: 'Open File Diff',
      arguments: [
        {
          sha: c.hash,
          fileUri: node.fileUri,
          hasParent: node.hasParent,
          logTip: this.logTipRef,
        },
      ],
    };
    return item;
  }

  async resolveTreeItem(
    item: vscode.TreeItem,
    node: LineHistoryNode,
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

  getChildren(parent?: LineHistoryNode): LineHistoryNode[] {
    if (parent) return [];
    const repo = this.git.activeRepo;
    if (!repo)
      return [{ kind: 'message', text: 'No Git repository detected.' }];
    if (!this.currentFileUri || !this.currentRange) {
      return [{ kind: 'message', text: 'Select a line to see its history.' }];
    }
    const out: LineHistoryNode[] = [...this.commits];
    if (this.loading) out.push({ kind: 'loading' });
    else if (this.errorMessage)
      out.push({ kind: 'message', text: `Error: ${this.errorMessage}` });
    else if (this.hasMore) out.push({ kind: 'loadMore' });
    else if (this.commits.length === 0)
      out.push({ kind: 'message', text: 'No history for this line range.' });
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
