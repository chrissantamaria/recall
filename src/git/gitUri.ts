import * as vscode from 'vscode';

export interface ActiveTarget {
  fileUri: vscode.Uri;
  ref?: string;
}

/**
 * Parse a git: scheme URI as produced by the built-in vscode.git extension's
 * toGitUri() helper. Query is JSON: { path: string, ref: string, submoduleOf?: string }.
 */
export function fromGitUri(
  uri: vscode.Uri,
): { fileUri: vscode.Uri; ref: string } | undefined {
  if (uri.scheme !== 'git') return undefined;
  try {
    const parsed = JSON.parse(uri.query) as { path?: unknown; ref?: unknown };
    if (typeof parsed.path !== 'string' || typeof parsed.ref !== 'string')
      return undefined;
    return { fileUri: vscode.Uri.file(parsed.path), ref: parsed.ref };
  } catch {
    return undefined;
  }
}

/**
 * Given the currently active text editor, compute the target file + optional ref
 * for history queries. Handles both plain workspace files and the two panes of a
 * diff editor (which use the git: scheme internally).
 *
 * Empty ref (produced by toGitUri(uri, '')) means "working tree" and is dropped.
 */
export function activeTargetFromEditor(
  editor: vscode.TextEditor | undefined,
): ActiveTarget | undefined {
  if (!editor) return undefined;
  const uri = editor.document.uri;
  if (uri.scheme === 'file') return { fileUri: uri };
  if (uri.scheme === 'git') {
    const parsed = fromGitUri(uri);
    if (!parsed) return undefined;
    const ref = parsed.ref.trim() === '' ? undefined : parsed.ref;
    return { fileUri: parsed.fileUri, ref };
  }
  return undefined;
}
