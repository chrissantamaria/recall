import * as path from 'node:path';
import * as vscode from 'vscode';

import type { GitService } from '../git/gitService';
import { shortSha } from '../util/format';

export async function openCommitFileDiff(
  git: GitService,
  sha: string,
  fileUri: vscode.Uri,
  hasParent: boolean,
): Promise<void> {
  const api = git.api;
  if (!api) return;
  const right = api.toGitUri(fileUri, sha);
  const left = hasParent
    ? api.toGitUri(fileUri, `${sha}^`)
    : api.toGitUri(fileUri, '');
  const title = `${path.basename(fileUri.fsPath)} (${shortSha(sha)})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, {
    preview: true,
  } satisfies vscode.TextDocumentShowOptions);
}

export async function openStashFileDiff(
  git: GitService,
  stashIndex: number,
  fileUri: vscode.Uri,
): Promise<void> {
  const api = git.api;
  if (!api) return;
  const stashRef = `stash@{${stashIndex}}`;
  const right = api.toGitUri(fileUri, stashRef);
  const left = api.toGitUri(fileUri, `${stashRef}^`);
  const title = `${path.basename(fileUri.fsPath)} (${stashRef})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, {
    preview: true,
  } satisfies vscode.TextDocumentShowOptions);
}
