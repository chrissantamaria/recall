import * as path from 'node:path';
import * as vscode from 'vscode';

import type { GitService } from '../git/gitService';
import {
  buildCommitTooltip,
  relativeTime,
  splitMessage,
  type CommitInfo,
} from '../util/format';

export interface StashEntry {
  index: number;
  ref: string;
  sha: string;
  subject: string;
  body: string;
  authorName?: string;
  authorEmail?: string;
  authorDate?: Date;
}

export interface StashFile {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';
  path: string;
  oldPath?: string;
}

type StashNode =
  | { kind: 'stash'; entry: StashEntry }
  | { kind: 'file'; stashIndex: number; file: StashFile; repoRoot: string }
  | { kind: 'message'; text: string };

export class StashProvider
  implements vscode.TreeDataProvider<StashNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    StashNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly git: GitService) {
    this.disposables.push(
      this.git.onDidChangeActiveRepo(() => this.refresh()),
      this.git.onDidChangeActiveRepoState(() => this.refresh()),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: StashNode): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(
        node.text,
        vscode.TreeItemCollapsibleState.None,
      );
      item.contextValue = 'message';
      return item;
    }
    if (node.kind === 'stash') {
      const e = node.entry;
      const parsed = parseStashSubject(e.subject);
      const label = parsed.title || e.ref;
      const descParts: string[] = [];
      if (parsed.branch) descParts.push(parsed.branch);
      if (e.authorDate) descParts.push(relativeTime(e.authorDate));
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = descParts.join(', ');
      item.iconPath = new vscode.ThemeIcon('archive');
      const info: CommitInfo = {
        hash: e.sha,
        subject: parsed.title || e.subject,
        body: e.body,
        authorName: e.authorName,
        authorEmail: e.authorEmail,
        authorDate: e.authorDate,
      };
      item.tooltip = buildCommitTooltip(info, { remote: this.git.remoteInfo });
      item.contextValue = 'stash';
      item.id = `stash-${e.ref}-${e.sha}`;
      return item;
    }
    const f = node.file;
    const item = new vscode.TreeItem(
      path.basename(f.path),
      vscode.TreeItemCollapsibleState.None,
    );
    const rel = path.dirname(f.path);
    item.description = rel === '.' ? undefined : rel;
    item.tooltip = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    item.resourceUri = vscode.Uri.file(path.join(node.repoRoot, f.path));
    item.iconPath = statusToIcon(f.status);
    item.contextValue = 'stashFile';
    item.command = {
      command: 'recall.stash.openFileDiff',
      title: 'Open File Diff',
      arguments: [{ stashIndex: node.stashIndex, fileUri: item.resourceUri }],
    };
    return item;
  }

  async getChildren(parent?: StashNode): Promise<StashNode[]> {
    const repo = this.git.activeRepo;
    if (!repo)
      return [{ kind: 'message', text: 'No Git repository detected.' }];

    if (!parent) {
      try {
        const entries = await this.listStashes();
        if (entries.length === 0) {
          return [{ kind: 'message', text: 'No stashes.' }];
        }
        return entries.map((entry) => ({ kind: 'stash' as const, entry }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [{ kind: 'message', text: `Error: ${msg}` }];
      }
    }

    if (parent.kind === 'stash') {
      try {
        const files = await this.listStashFiles(parent.entry.ref);
        if (files.length === 0)
          return [{ kind: 'message', text: 'No files in this stash.' }];
        return files.map((file) => ({
          kind: 'file' as const,
          stashIndex: parent.entry.index,
          file,
          repoRoot: repo.rootUri.fsPath,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [{ kind: 'message', text: `Error: ${msg}` }];
      }
    }
    return [];
  }

  private async listStashes(): Promise<StashEntry[]> {
    const US = '\x1f';
    const RS = '\x1e';
    const fmt = ['%H', '%gd', '%s', '%b', '%aN', '%aE', '%aI'].join(US) + RS;
    const raw = await this.git.runGit(['stash', 'list', `--format=${fmt}`]);
    const records = raw
      .split(RS)
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    const out: StashEntry[] = [];
    for (const rec of records) {
      const [sha, ref, subjectRaw, body, authorName, authorEmail, authorISO] =
        rec.split(US);
      const m = /stash@\{(?<index>\d+)\}/.exec(ref ?? '');
      if (!m || !m.groups) continue;
      const index = parseInt(m.groups.index, 10);
      const { subject } = splitMessage(subjectRaw ?? '');
      out.push({
        index,
        ref: ref ?? `stash@{${index}}`,
        sha: sha ?? '',
        subject,
        body: body ?? '',
        authorName: authorName || undefined,
        authorEmail: authorEmail || undefined,
        authorDate: authorISO ? new Date(authorISO) : undefined,
      });
    }
    return out;
  }

  private async listStashFiles(stashRef: string): Promise<StashFile[]> {
    const raw = await this.git.runGit([
      'stash',
      'show',
      '--name-status',
      '-z',
      stashRef,
    ]);
    return parseNameStatusZ(raw);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * Break apart the default stash subject produced by git.
 *
 *   "On <branch>: <name>"                          - named (git stash push -m ...)
 *   "WIP on <branch>: <sha> <head-commit-subject>" - unnamed (git stash / git stash push)
 *
 * We surface the user-meaningful portion as the title ("<name>" or "WIP: <head>"),
 * and the branch separately for the muted description row. Anything that doesn't
 * match either shape falls through to { title: subject } with no branch.
 */
function parseStashSubject(subject: string): {
  branch?: string;
  title: string;
} {
  const wip = /^WIP on (?<branch>[^:]+): [0-9a-f]+ (?<title>.+)$/.exec(subject);
  if (wip?.groups) {
    return { branch: wip.groups.branch, title: `WIP: ${wip.groups.title}` };
  }
  const named = /^On (?<branch>[^:]+): (?<title>.+)$/.exec(subject);
  if (named?.groups) {
    return { branch: named.groups.branch, title: named.groups.title };
  }
  return { title: subject };
}

function parseNameStatusZ(output: string): StashFile[] {
  const tokens = output.split('\x00').filter((t) => t.length > 0);
  const files: StashFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusTok = tokens[i++];
    if (!statusTok) break;
    const code = statusTok.charAt(0).toUpperCase();
    const isRenameOrCopy = code === 'R' || code === 'C';
    if (isRenameOrCopy) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (!newPath) break;
      files.push({
        status: code,
        path: newPath,
        oldPath,
      });
    } else {
      const p = tokens[i++];
      if (!p) break;
      const s: StashFile['status'] =
        code === 'A' ||
        code === 'M' ||
        code === 'D' ||
        code === 'T' ||
        code === 'U'
          ? code
          : '?';
      files.push({ status: s, path: p });
    }
  }
  return files;
}

function statusToIcon(status: StashFile['status']): vscode.ThemeIcon {
  switch (status) {
    case 'A':
      return new vscode.ThemeIcon(
        'diff-added',
        new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      );
    case 'D':
      return new vscode.ThemeIcon(
        'diff-removed',
        new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
      );
    case 'R':
      return new vscode.ThemeIcon(
        'diff-renamed',
        new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
      );
    case 'C':
      return new vscode.ThemeIcon(
        'diff-added',
        new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      );
    case 'M':
      return new vscode.ThemeIcon(
        'diff-modified',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      );
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}
