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
    vscode.window.createTreeView('backpocket.fileHistory', {
      treeDataProvider: fileHistory,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView('backpocket.lineHistory', {
      treeDataProvider: lineHistory,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView('backpocket.stashes', {
      treeDataProvider: stashes,
      showCollapseAll: true,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('backpocket.refresh', () => {
      fileHistory.refresh();
      lineHistory.refresh();
      stashes.refresh();
    }),
    vscode.commands.registerCommand('backpocket.fileHistory.loadMore', () =>
      fileHistory.loadMore(),
    ),
    vscode.commands.registerCommand('backpocket.lineHistory.loadMore', () =>
      lineHistory.loadMore(),
    ),
    vscode.commands.registerCommand(
      'backpocket.openFileDiff',
      async (arg: {
        sha: string;
        fileUri: vscode.Uri;
        hasParent: boolean;
        logTip?: string;
      }) => {
        try {
          await openCommitFileDiff(
            git,
            arg.sha,
            arg.fileUri,
            arg.hasParent,
            arg.logTip ?? 'HEAD',
          );
        } catch (err) {
          void vscode.window.showErrorMessage(`Backpocket: ${errMsg(err)}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'backpocket.stash.openFileDiff',
      async (arg: { stashIndex: number; fileUri: vscode.Uri }) => {
        try {
          await openStashFileDiff(git, arg.stashIndex, arg.fileUri);
        } catch (err) {
          void vscode.window.showErrorMessage(`Backpocket: ${errMsg(err)}`);
        }
      },
    ),
    vscode.commands.registerCommand('backpocket.stash.apply', (node: unknown) =>
      runStashAction(git, stashes, 'apply', node),
    ),
    vscode.commands.registerCommand(
      'backpocket.stash.applyFile',
      (node: unknown) => applyStashFile(git, stashes, node),
    ),
    vscode.commands.registerCommand('backpocket.stash.pop', (node: unknown) =>
      runStashAction(git, stashes, 'pop', node),
    ),
    vscode.commands.registerCommand('backpocket.stash.drop', (node: unknown) =>
      runStashAction(git, stashes, 'drop', node),
    ),
    vscode.commands.registerCommand(
      'backpocket.stash.stashChanges',
      async (...resources: { resourceUri: vscode.Uri }[]) => {
        try {
          await stashSelectedChanges(git, stashes, resources);
        } catch (err) {
          void vscode.window.showErrorMessage(`Backpocket: ${errMsg(err)}`);
        }
      },
    ),
    vscode.commands.registerCommand('backpocket.copySha', (sha: string) => {
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

function extractStashFileApply(
  node: unknown,
): { stashIndex: number; relPath: string } | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as {
    kind?: unknown;
    stashIndex?: unknown;
    file?: { path?: unknown };
  };
  if (n.kind !== 'file') return undefined;
  const stashIndex = n.stashIndex;
  const relPath = n.file?.path;
  return typeof stashIndex === 'number' && typeof relPath === 'string'
    ? { stashIndex, relPath }
    : undefined;
}

async function applyStashFile(
  git: GitService,
  stashes: StashProvider,
  node: unknown,
): Promise<void> {
  const repo = git.activeRepo;
  if (!repo) {
    void vscode.window.showErrorMessage(
      'Backpocket: no active Git repository.',
    );
    return;
  }
  const spec = extractStashFileApply(node);
  if (!spec) {
    void vscode.window.showErrorMessage(
      'Backpocket: right-click a file under a stash to apply it.',
    );
    return;
  }
  const stashRef = `stash@{${spec.stashIndex}}`;
  const rootPath = repo.rootUri.fsPath;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: 'Applying stashed file...',
      },
      () =>
        git.runGit(
          ['restore', '--source', stashRef, '--worktree', '--', spec.relPath],
          { cwd: rootPath },
        ),
    );
    stashes.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(`Backpocket: ${errMsg(err)}`);
  }
}

async function runStashAction(
  git: GitService,
  stashes: StashProvider,
  action: StashAction,
  node: unknown,
): Promise<void> {
  const repo = git.activeRepo;
  if (!repo) {
    void vscode.window.showErrorMessage(
      'Backpocket: no active Git repository.',
    );
    return;
  }
  const index = extractStashIndex(node);
  if (index === undefined) {
    void vscode.window.showErrorMessage(
      'Backpocket: right-click a stash to use this action.',
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
    void vscode.window.showErrorMessage(`Backpocket: ${errMsg(err)}`);
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
    void vscode.window.showErrorMessage(
      'Backpocket: no active Git repository.',
    );
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
