import * as vscode from 'vscode';

import { AvatarCache } from './avatars/avatarCache';
import { BlameService } from './blame/blameService';
import { BlameStatusBar } from './blame/blameStatusBar';
import { InlineBlameDecoration } from './blame/inlineBlameDecoration';
import { openCommitFileDiff, openStashFileDiff } from './diff/openDiff';
import { GitService } from './git/gitService';
import { FileHistoryProvider } from './providers/fileHistoryProvider';
import { LineHistoryProvider } from './providers/lineHistoryProvider';
import { StashProvider } from './providers/stashProvider';

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const git = new GitService();
  context.subscriptions.push(git);
  await git.initialize();

  const avatars = new AvatarCache(context);
  context.subscriptions.push(avatars);

  const blameService = new BlameService(git);
  const inlineBlame = new InlineBlameDecoration(blameService, git, avatars);
  const blameStatusBar = new BlameStatusBar(blameService, git, avatars);
  context.subscriptions.push(blameService, inlineBlame, blameStatusBar);

  const fileHistory = new FileHistoryProvider(git, avatars);
  const lineHistory = new LineHistoryProvider(git, avatars);
  const stashes = new StashProvider(git);
  context.subscriptions.push(fileHistory, lineHistory, stashes);

  context.subscriptions.push(
    vscode.window.createTreeView('recall.fileHistory', {
      treeDataProvider: fileHistory,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView('recall.lineHistory', {
      treeDataProvider: lineHistory,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView('recall.stashes', {
      treeDataProvider: stashes,
      showCollapseAll: true,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('recall.refresh', () => {
      fileHistory.refresh();
      lineHistory.refresh();
      stashes.refresh();
    }),
    vscode.commands.registerCommand('recall.fileHistory.loadMore', () =>
      fileHistory.loadMore(),
    ),
    vscode.commands.registerCommand('recall.lineHistory.loadMore', () =>
      lineHistory.loadMore(),
    ),
    vscode.commands.registerCommand(
      'recall.openFileDiff',
      async (arg: { sha: string; fileUri: vscode.Uri; hasParent: boolean }) => {
        try {
          await openCommitFileDiff(git, arg.sha, arg.fileUri, arg.hasParent);
        } catch (err) {
          void vscode.window.showErrorMessage(`Recall: ${errMsg(err)}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'recall.stash.openFileDiff',
      async (arg: { stashIndex: number; fileUri: vscode.Uri }) => {
        try {
          await openStashFileDiff(git, arg.stashIndex, arg.fileUri);
        } catch (err) {
          void vscode.window.showErrorMessage(`Recall: ${errMsg(err)}`);
        }
      },
    ),
    vscode.commands.registerCommand('recall.stash.apply', (node: unknown) =>
      runStashAction(git, stashes, 'apply', node),
    ),
    vscode.commands.registerCommand('recall.stash.pop', (node: unknown) =>
      runStashAction(git, stashes, 'pop', node),
    ),
    vscode.commands.registerCommand('recall.stash.drop', (node: unknown) =>
      runStashAction(git, stashes, 'drop', node),
    ),
    vscode.commands.registerCommand(
      'recall.stash.stashChanges',
      async (...resources: { resourceUri: vscode.Uri }[]) => {
        try {
          await stashSelectedChanges(git, stashes, resources);
        } catch (err) {
          void vscode.window.showErrorMessage(`Recall: ${errMsg(err)}`);
        }
      },
    ),
    vscode.commands.registerCommand('recall.copySha', (sha: string) => {
      void vscode.env.clipboard.writeText(sha);
    }),
  );
}

export function deactivate(): void {}

type StashAction = 'apply' | 'pop' | 'drop';

function extractStashIndex(node: unknown): number | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as { kind?: unknown; entry?: { index?: unknown } };
  if (n.kind !== 'stash') return undefined;
  const idx = n.entry?.index;
  return typeof idx === 'number' ? idx : undefined;
}

async function runStashAction(
  git: GitService,
  stashes: StashProvider,
  action: StashAction,
  node: unknown,
): Promise<void> {
  const repo = git.activeRepo;
  if (!repo) {
    void vscode.window.showErrorMessage('Recall: no active Git repository.');
    return;
  }
  const index = extractStashIndex(node);
  if (index === undefined) {
    void vscode.window.showErrorMessage(
      'Recall: right-click a stash to use this action.',
    );
    return;
  }

  if (action === 'drop') {
    const answer = await vscode.window.showWarningMessage(
      `Drop stash@{${index}}? This cannot be undone.`,
      { modal: true },
      'Drop',
    );
    if (answer !== 'Drop') return;
  }

  const title =
    action === 'apply'
      ? 'Applying stash...'
      : action === 'pop'
        ? 'Popping stash...'
        : 'Dropping stash...';

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title },
      async () => {
        if (action === 'apply') await repo.applyStash(index);
        else if (action === 'pop') await repo.popStash(index);
        else await repo.dropStash(index);
      },
    );
    stashes.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(`Recall: ${errMsg(err)}`);
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function stashSelectedChanges(
  git: GitService,
  stashes: StashProvider,
  resources: { resourceUri: vscode.Uri }[],
): Promise<void> {
  if (resources.length === 0) return;

  const repo = git.activeRepo;
  if (!repo) {
    void vscode.window.showErrorMessage('Recall: no active Git repository.');
    return;
  }

  const message = await vscode.window.showInputBox({
    prompt: 'Stash message',
  });
  if (message === undefined) return;

  const rootPath = repo.rootUri.fsPath;
  const paths = resources.map((r) =>
    vscode.workspace.asRelativePath(r.resourceUri, false),
  );

  const args = ['stash', 'push'];
  if (message) {
    args.push('-m', message);
  }
  args.push('--', ...paths);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.SourceControl, title: 'Stashing...' },
    () => git.runGit(args, { cwd: rootPath }),
  );

  stashes.refresh();
}
