import * as vscode from 'vscode';

import type { AvatarCache } from '../avatars/avatarCache';
import type { GitService } from '../git/gitService';
import { debounce } from '../util/debounce';
import { buildCommitTooltip, relativeTime } from '../util/format';
import { BlameService, isUncommitted } from './blameService';

export class InlineBlameDecoration implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly decorationType: vscode.TextEditorDecorationType;

  constructor(
    private readonly blameService: BlameService,
    private readonly git: GitService,
    private readonly avatars: AvatarCache,
  ) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: '0 0 0 3em',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });

    const debouncedUpdate = debounce(() => void this.update(), 100);

    this.disposables.push(
      this.decorationType,
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) debouncedUpdate();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => void this.update()),
      this.blameService.onDidChange(() => void this.update()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && e.document === editor.document) {
          editor.setDecorations(this.decorationType, []);
        }
      }),
    );

    void this.update();
  }

  private async update(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    if (!this.isEnabled()) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    if (editor.document.isDirty) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const line = editor.selection.active.line;
    const info = await this.blameService.getLineBlame(editor.document, line);

    if (vscode.window.activeTextEditor !== editor) return;
    if (editor.selection.active.line !== line) return;

    if (!info || isUncommitted(info)) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const isYou = this.blameService.isCurrentUser(info.authorEmail);
    const author = isYou ? 'You' : info.authorName;
    const time = relativeTime(info.authorDate);
    const message = truncate(info.summary, 50);
    const text = `${author}, ${time} \u00b7 ${message}`;

    const body = await this.blameService.getCommitBody(info.sha);
    const diffStat = await this.blameService.getCommitStat(info.sha);

    if (vscode.window.activeTextEditor !== editor) return;
    if (editor.selection.active.line !== line) return;

    const avatarAssets = this.avatars.get(info.authorEmail, info.authorName);
    const tooltip = buildCommitTooltip(
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

    const range = new vscode.Range(
      line,
      Number.MAX_SAFE_INTEGER,
      line,
      Number.MAX_SAFE_INTEGER,
    );
    editor.setDecorations(this.decorationType, [
      {
        range,
        hoverMessage: tooltip,
        renderOptions: { after: { contentText: text } },
      },
    ]);
  }

  private isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('recall.blame.inline')
      .get('enabled', true);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}
