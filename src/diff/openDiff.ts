import * as path from 'node:path';
import * as vscode from 'vscode';

import type { GitService } from '../git/gitService';
import { shortSha } from '../util/format';

/** `git hash-object -t tree /dev/null` — vscode.git uses this when diffing a file's first revision. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const COMMIT_HASH_LINE = /^[0-9a-f]{40}$/;

function toPosixRel(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function pathsEqual(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

async function gitObjectExists(
  git: GitService,
  cwd: string,
  rev: string,
  posixRel: string,
): Promise<boolean> {
  try {
    await git.runGit(['cat-file', '-e', `${rev}:${posixRel}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Repo-relative path for `treeRev` on the `--follow` chain of `posixRelAtTip` from
 * `logTip` (same idea as `git log treeRev..logTip --follow -- path-at-tip`).
 */
async function pathInTreeAtRevision(
  git: GitService,
  cwd: string,
  posixRelAtTip: string,
  logTip: string,
  treeRev: string,
): Promise<string> {
  if (treeRev === logTip) return posixRelAtTip;
  let raw: string;
  try {
    raw = await git.runGit(
      [
        'log',
        '--follow',
        '--name-status',
        '--pretty=format:%H',
        `${treeRev}..${logTip}`,
        '--',
        posixRelAtTip,
      ],
      { cwd },
    );
  } catch {
    return posixRelAtTip;
  }

  let path = posixRelAtTip;
  for (const chunk of raw.trimEnd().split(/\n\n+/)) {
    const lines = chunk
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const head0 = lines[0];
    if (head0 === undefined) continue;
    const head = head0.trim();
    if (!COMMIT_HASH_LINE.test(head)) continue;
    for (const line of lines.slice(1)) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const status = parts[0];
      if (status === undefined) continue;
      const kind = status.charAt(0);
      if (kind !== 'R' && kind !== 'C') continue;
      const oldP = parts[1];
      const newP = parts[2];
      if (oldP !== undefined && newP !== undefined && pathsEqual(path, newP)) {
        path = oldP;
      }
    }
  }
  return path;
}

async function pathsForParentChildDiff(
  git: GitService,
  cwd: string,
  posixRel: string,
  sha: string,
  logTip: string,
): Promise<{ leftRel: string; rightRel: string }> {
  const parent = `${sha}^`;
  const [leftOk, rightOk] = await Promise.all([
    gitObjectExists(git, cwd, parent, posixRel),
    gitObjectExists(git, cwd, sha, posixRel),
  ]);
  if (leftOk && rightOk) {
    return { leftRel: posixRel, rightRel: posixRel };
  }
  const [rightRel, leftRel] = await Promise.all([
    pathInTreeAtRevision(git, cwd, posixRel, logTip, sha),
    pathInTreeAtRevision(git, cwd, posixRel, logTip, parent),
  ]);
  return { leftRel, rightRel };
}

function uriForRepoRel(cwd: string, rel: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.Uri.file(cwd), ...rel.split('/'));
}

export async function openCommitFileDiff(
  git: GitService,
  sha: string,
  fileUri: vscode.Uri,
  hasParent: boolean,
  logTip: string = 'HEAD',
): Promise<void> {
  const api = git.api;
  if (!api) return;
  const repo = git.activeRepo;
  if (!repo) return;

  const cwd = repo.rootUri.fsPath;
  const relPath = path.relative(cwd, fileUri.fsPath);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
    return;
  }
  const posixRel = toPosixRel(relPath);

  if (!hasParent) {
    const title = `${path.basename(fileUri.fsPath)} (${shortSha(sha)})`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      api.toGitUri(fileUri, ''),
      api.toGitUri(fileUri, sha),
      title,
      { preview: true } satisfies vscode.TextDocumentShowOptions,
    );
    return;
  }

  const { leftRel, rightRel } = await pathsForParentChildDiff(
    git,
    cwd,
    posixRel,
    sha,
    logTip,
  );
  const leftUri = uriForRepoRel(cwd, leftRel);
  const rightUri = uriForRepoRel(cwd, rightRel);
  const parentRef = `${sha}^`;
  const leftRef = (await gitObjectExists(git, cwd, parentRef, leftRel))
    ? parentRef
    : EMPTY_TREE_SHA;
  const title = `${path.basename(rightUri.fsPath)} (${shortSha(sha)})`;

  await vscode.commands.executeCommand(
    'vscode.diff',
    api.toGitUri(leftUri, leftRef),
    api.toGitUri(rightUri, sha),
    title,
    { preview: true } satisfies vscode.TextDocumentShowOptions,
  );
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
