import * as vscode from 'vscode';

import type { AvatarCache } from '../avatars/avatarCache';
import type { GitService } from '../git/gitService';
import { debounce } from '../util/debounce';
import { buildCommitTooltip, relativeTime } from '../util/format';
import { BlameService, isUncommitted } from './blameService';

export class BlameStatusBar implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(
    private readonly blameService: BlameService,
    private readonly git: GitService,
    private readonly avatars: AvatarCache,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'backpocket.blame',
      vscode.StatusBarAlignment.Right,
      500,
    );

    const debouncedUpdate = debounce(() => void this.update(), 100);

    this.disposables.push(
      this.statusBarItem,
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) debouncedUpdate();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => void this.update()),
      this.blameService.onDidChange(() => void this.update()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && e.document === editor.document) {
          this.statusBarItem.hide();
        }
      }),
    );

    void this.update();
  }

  private async update(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.isDirty || !this.isEnabled()) {
      this.statusBarItem.hide();
      return;
    }

    const line = editor.selection.active.line;
    const info = await this.blameService.getLineBlame(editor.document, line);

    if (vscode.window.activeTextEditor !== editor) return;
    if (editor.selection.active.line !== line) return;

    if (!info || isUncommitted(info)) {
      this.statusBarItem.hide();
      return;
    }

    const isYou = this.blameService.isCurrentUser(info.authorEmail);
    const author = isYou ? 'You' : info.authorName;
    this.statusBarItem.text = `$(git-commit) ${author}, ${relativeTime(info.authorDate)}`;

    const body = await this.blameService.getCommitBody(info.sha);
    const diffStat = await this.blameService.getCommitStat(info.sha);

    if (vscode.window.activeTextEditor !== editor) return;
    if (editor.selection.active.line !== line) return;

    const avatarAssets = this.avatars.get(info.authorEmail, info.authorName);
    this.statusBarItem.tooltip = buildCommitTooltip(
      {
        hash: info.sha,
        subject: info.summary,
        body,
        authorName: info.authorName,
        authorEmail: info.authorEmail,
        authorDate: info.authorDate,
      },
      {
        avatarDataUri: avatarAssets.dataUri,
        remote: this.git.remoteInfo,
        diffStat,
      },
    );

    this.statusBarItem.command = {
      command: 'backpocket.openFileDiff',
      title: 'Open Commit Diff',
      arguments: [
        { sha: info.sha, fileUri: editor.document.uri, hasParent: true },
      ],
    };

    this.statusBarItem.show();
  }

  private isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('backpocket.blame.statusBar')
      .get('enabled', true);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
