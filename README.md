# Recall

A minimal VS Code extension that adds three tree views to the built-in **Source Control** sidebar:

- **File History** — commits touching the currently open file.
- **Line History** — commits touching the currently selected line range (uses `git log -L`).
- **Stashes** — expandable list of stashes with per-file diffs and right-click **Apply / Pop / Drop** actions.

Single active repository (auto-selected from the active editor). Uses the bundled `vscode.git` extension API for most operations and shells out to `git` only where the API does not expose what is needed.

## Screenshots

_Screenshots pending — run the extension and capture the three panels inside the Source Control sidebar._

## Features

- File History list with author avatars (Gravatar, cached locally)
- Tooltip on each commit shows full subject, body, author, email, and relative/absolute dates
- Click a commit to open a file-scoped diff (`sha^` vs `sha`) in a VS Code diff editor
- Line History follows the editor's current selection (debounced), with pagination via a "Load more..." tree item
- Stash list with null-delimited parsing for robust handling of multi-line stash messages
- Expanding a stash shows the files it modifies; clicking a file opens a stash-vs-parent diff
- Right-click a stash for **Apply**, **Pop**, or **Drop** (with confirmation)
- Refresh button on every view title bar
- Empty-state welcome messages when no file is open or no repo is detected

## Requirements

- VS Code `^1.85.0`
- The built-in `vscode.git` extension must be enabled (it is by default)
- `git` available on `PATH` (VS Code's own git configuration is used automatically)

## Install from source

```bash
pnpm install
pnpm run build
# Press F5 in VS Code to launch an Extension Development Host
```

## Package as a VSIX

```bash
pnpm dlx @vscode/vsce package --no-dependencies
# Produces recall-0.1.0.vsix in the project root
# --no-dependencies is required because vsce does not understand pnpm's layout;
# safe here because esbuild bundles everything into dist/extension.js.
code --install-extension recall-0.1.0.vsix
```

## Architecture

- `src/extension.ts` — activation entry point; registers providers, views, and commands.
- `src/git/gitService.ts` — acquires the `vscode.git` API, tracks the active repository, and exposes a `runGit(args)` wrapper for shelling out.
- `src/providers/fileHistoryProvider.ts` — tree data provider backed by `repo.log({ path })`.
- `src/providers/lineHistoryProvider.ts` — tree data provider backed by `git log -L<start>,<end>:<path>`.
- `src/providers/stashProvider.ts` — tree data provider for stashes; parses `git stash list` and `git stash show --name-status -z`.
- `src/diff/openDiff.ts` — opens file-scoped diffs using `api.toGitUri(uri, ref)` + the `vscode.diff` command.
- `src/avatars/avatarCache.ts` — Gravatar avatar downloader, cached as PNGs under `globalStorageUri/avatars/`. Falls back to the `$(person)` codicon when offline or missing.

## Known limitations (v1)

- Single repository only. In a multi-root workspace with multiple git repos, only the one matching the active editor (or the first one otherwise) is shown.
- No inline blame / current-line hover.
- No search/filter input.
- No "create stash" action (use the built-in Git UI).
- Submodules are treated as part of their parent repository.
