# Recall — agent context

A VS Code extension contributing three tree views into the built-in Source Control sidebar (**File History**, **Line History**, **Stashes**) plus inline blame annotations and a blame status bar item. Single-active-repo model (auto-selected from the active editor). Built with esbuild, typechecked with tsc, managed with pnpm.

## Conventions

- **TypeScript: no semicolons, single quotes** (or backticks when necessary). `src/providers/stashProvider.ts` has legacy semicolons from an earlier formatter pass - don't add more, but don't bulk-reformat either unless asked.
- Never import from `vscode` at the top level of anything that might be loaded outside the extension host. Put `import * as vscode from 'vscode'` only in files that activate via the extension entry point.
- Prefer `node:` prefix imports for Node builtins (`node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:https`).

## Build, run, package

```
pnpm install           # dependencies (pnpm 9.x; packageManager field pins the version)
pnpm run typecheck     # tsc --noEmit, no emit
pnpm run build         # esbuild bundles src/extension.ts -> dist/extension.js
pnpm run watch         # esbuild --watch for dev
pnpm dlx @vscode/vsce package --no-dependencies   # produces recall-0.1.0.vsix; --no-deps because pnpm's layout confuses vsce (safe since esbuild inlines everything)
```

**Dev loop.** Open the repo in VS Code, F5 launches an Extension Development Host (the `preLaunchTask: "build"` runs first). For subsequent code changes: **Cmd+R** in the debug window picks up rebuilt `dist/extension.js`. Manifest changes (`package.json` views, commands, menus, activation events) require a full debug-session restart, not just Cmd+R. Run `pnpm run watch` in a terminal to auto-rebuild on save.

## Architecture map

```
src/
  extension.ts               # activate() - wires providers, commands, views
  git/
    git.d.ts                 # local copy of vscode.git's API types (subset we use)
    gitService.ts            # tracks active repo, exposes runGit/streamGit, remoteInfo
    gitUri.ts                # parses git: scheme URIs used by diff editors
    remote.ts                # parses remote URL -> { commitUrl(sha), pullUrl(n) }
  providers/
    fileHistoryProvider.ts   # TreeDataProvider; streaming git log with Load more
    lineHistoryProvider.ts   # TreeDataProvider; git log -L with Load more
    stashProvider.ts         # TreeDataProvider; stash list + expandable file list
  blame/
    blameService.ts          # git blame --porcelain, per-file cache, "You" detection
    inlineBlameDecoration.ts # TextEditorDecorationType after pseudo-element on cursor line
    blameStatusBar.ts        # StatusBarItem with commit tooltip on hover
  diff/
    openDiff.ts              # vscode.diff + api.toGitUri helpers
  avatars/
    avatarCache.ts           # synthesized colored-initials SVG per author (offline)
  util/
    debounce.ts
    format.ts                # shortSha, relativeTime, buildCommitTooltip, splitMessage
```

All command/view IDs are namespaced `recall.*` (e.g. `recall.fileHistory`, `recall.stash.apply`). Published extension id is `local.recall` during development.

## Key technical constraints (non-obvious - read before editing)

### 1. The built-in `vscode.git` API does most of our work

We acquire it via `vscode.extensions.getExtension<GitExtension>('vscode.git').exports.getAPI(1)`. It gives us:

- `api.getRepository(uri)` for repo discovery from the active file
- `repo.log({ path, maxEntries })` for non-streaming file history (we no longer use this - see below)
- `api.toGitUri(uri, ref)` for diff URIs (resolved by git extension's content provider)
- `repo.applyStash / popStash / dropStash` for stash actions
- `repo.state.onDidChange` for "git state changed" refresh hook
- `api.git.path` for the resolved git binary (use this, not PATH)

### 2. We shell out via `GitService.streamGit` for everything history-related

`repo.log()` returns `Promise<Commit[]>` - no streaming. In large monorepos (measured against `~/figma/figma`, 7.5M objects, 6.58 GiB pack) a single `git log -n 200 -- <path>` takes 14-15 seconds. Streaming reduces time-to-first-commit to ~160ms.

`streamGit(args, onRecord, { cwd, signal, recordSeparator })` spawns git, accumulates stdout chunks, and fires `onRecord` for every `\x1e`-delimited record as it arrives. `AbortSignal` cancellation kills the child and resolves silently. Record format is null-ish:

```
FMT = [%H, %s, %b, %aN, %aE, %aI, %P].join('\x1f') + '\x1e'
```

Unit separator `\x1f` between fields, record separator `\x1e` between commits. Parse with `rec.split('\x1f')`.

### 3. Both history providers use streaming + cancellation + Load more

- **File history**: page size 50, `git log --follow -n 50 --format=... [<ref>] -- <relPath>`. Load more passes `<lastSha>^` as starting rev so git doesn't re-walk from HEAD.
- **Line history**: page size 25, `git log -L<s>,<e>:<relPath> --no-patch -n <25*pages> --format=... [<ref>]`. Load more bumps `-n` and restarts because `-L` interprets line ranges relative to whatever rev tip you give it - commit-range trick doesn't work. Existing commits stay visible until the new stream catches up.
- Both cancel any in-flight query when the active editor/selection changes, via `AbortController` stored on the provider.
- A debounced `fireSoon` (80ms) throttles `_onDidChangeTreeData.fire()` so streaming records don't thrash the UI.

### 4. Diff editor panes are valid targets, not "no file"

When the user clicks a commit, we call `vscode.diff` which makes a `git:` scheme URI the active editor. Without handling this, the tree views clear to the empty state.

`src/git/gitUri.ts::activeTargetFromEditor(editor)` returns `{ fileUri, ref? }`:

- `file:` URIs → `{ fileUri: editor.uri }` (ref undefined, i.e. HEAD)
- `git:` URIs → parse `JSON.parse(uri.query)` which has `{ path, ref }`; return `{ fileUri: Uri.file(path), ref }`. Empty ref means working tree, treated as undefined.
- Anything else → undefined. When this happens, **providers keep the previous list** instead of clearing (important UX - don't regress this).

Passing `ref` to `git log` makes the viewed commit sit at the top of the history. For line history, git interprets the line range relative to that ref's version of the file - this is what makes "select a line on the OLD side of a diff" show the pre-commit history correctly. Left pane's ref is `sha^`, right pane's ref is `sha` - handled automatically.

### 5. Avatars: synthesized SVG, written synchronously

`AvatarCache.get(email, name)` returns `{ iconUri, dataUri }`. On first sight for an (email, name) we:

1. Render a colored-initials SVG (palette of 16 colors, picked from MD5 of email; initials derived from name or email local part).
2. **Write it with `fs.writeFileSync` before returning** - async write via `vscode.workspace.fs.writeFile` caused VS Code to cache a 404 for the iconPath and never retry. The sync write is the whole fix.
3. Also precompute a `data:image/svg+xml;base64,...` URI for embedding inside MarkdownString tooltips (data URIs sidestep any file-scheme sanitizer quirks).
4. Fire-and-forget Gravatar lookup (`?s=96&d=404`); on 200 we overwrite with the PNG. 404/offline is the common case and we stay on the SVG.

Stash items don't use avatars (assumption: it's always you). They use `ThemeIcon('archive')`.

### 6. Tooltip markdown quirks

`buildCommitTooltip(commit, { avatarDataUri?, remote? })` in `src/util/format.ts`. MarkdownString config: `supportHtml = true, isTrusted = false`.

- **Inline `style` attributes are stripped** by VS Code's sanitizer. To vertically align the avatar next to the title we use a `<table>` (cells default to `vertical-align: middle`).
- **Markdown inside an HTML block is not parsed** by markdown-it. Since the title sits inside `<table>`, `linkifyIssues` emits `<a href="...">#N</a>` HTML anchors, not `[#N](url)` markdown. HTML anchors work in both the (table-wrapped) title and the (paragraph-level) body.
- The body is passed through with minimal escaping (`escapeMdMinimal`, backslashes only) so authored markdown (`[text](url)`, `**bold**`, code spans) renders naturally. User-authored `[#123](url)` is detected and skipped to avoid double-linking.
- Meta row order: `title` → `sha · author · date` → `body`. SHA is a link to the remote commit page. Author is a `mailto:` link when an email is known. Date uses `toLocaleString` with `month: 'short'` formatting plus `relativeTime()` (e.g. `"2 hours ago (Apr 20, 2026, 6:16 PM)"`).

### 7. Remote URL detection

`src/git/remote.ts::parseRemoteUrl(url)` handles `git@host:owner/repo[.git]`, `ssh://git@host/...`, and `https://host/...`. Detects GitHub / GitLab / Bitbucket by hostname substring match (so `github.mycorp.io` works as enterprise GitHub).

`GitService.remoteInfo` picks `upstream` → `origin` → first remote, parses its fetch/push URL. Returns `{ commitUrl(sha), pullUrl(n) }`. Providers pass this into the tooltip builder.

### 8. Inline blame: full-file cache, debounced updates

`BlameService` runs `git blame --porcelain -- <relPath>` once per file, parses into a `Map<lineNumber, BlameLineInfo>`, and caches keyed by `(fsPath, document.version)`. Subsequent cursor moves are synchronous map lookups — no git process spawned.

Cache invalidation: on `onDidSaveTextDocument` (that file) and `onDidChangeActiveRepoState` (all files). Dirty documents return no blame (decorations hide while typing, reappear on save).

"You" detection: resolves `git config user.email` on init and repo change. `isCurrentUser(email)` compares case-insensitively.

Both `InlineBlameDecoration` and `BlameStatusBar` share the same update pattern: debounced 100ms on selection change, stale-async guard (verify editor + line unchanged after await), immediate clear on document edit. Both respect their `recall.blame.{inline,statusBar}.enabled` setting.

## Cookbook

### Add a new command

1. Add a `contributes.commands` entry in `package.json`.
2. Hide it from the palette if it's only for right-click context: add a `menus.commandPalette` entry with `"when": "false"`.
3. Wire via `vscode.commands.registerCommand(...)` in `src/extension.ts::activate`.
4. Add to `menus.view/item/context` with a `viewItem == <contextValue>` when-clause if it's a right-click action.

### Add a tree-item right-click action

Set `contextValue` on the `TreeItem` in the provider. Match it in `menus.view/item/context` in `package.json`.

### Add a right-click action to native SCM resource states (Changes tab)

Use `menus.scm/resourceState/context` in `package.json` with `"when": "scmProvider == git"`. The command handler receives each selected resource as a **separate argument** (variadic), NOT as `(clicked, allSelected[])` like tree view context menus. Use rest parameters:

```typescript
vscode.commands.registerCommand(
  'recall.example',
  async (...resources: { resourceUri: vscode.Uri }[]) => {
    // resources contains ALL selected items
  },
);
```

### Change tooltip layout

All in `src/util/format.ts::buildCommitTooltip`. Remember: any new content inside the header `<table>` is raw HTML (not markdown-parsed). Content below the table is in a markdown paragraph and can mix authored markdown + inline HTML.

### Tune history performance

- The git-level floor in large monorepos is ~5-15s per full walk. Streaming is the main lever, already in place.
- `--first-parent` gives ~2x speedup (trade: hides commits reached only through merged branches). Could be exposed as a setting.
- `--no-renames` (file history only) gives ~40% speedup (trade: stops following past renames).
- The page sizes (50 / 25) are modest on purpose so the `-n` cap terminates walks sooner for hot files. Increase only if you're changing the streaming model.

### Debug a "history is empty" regression

Probably git-URI handling. Check that `activeTargetFromEditor` handles the new case, and that the provider's "no target" branch keeps the last list instead of clearing.

### Modify inline blame appearance or behavior

All in `src/blame/inlineBlameDecoration.ts`. The decoration type is created once in the constructor (color uses `editorCodeLens.foreground` ThemeColor). Text format is built in `update()` — author, relative time, middle-dot separator, truncated commit message. The hover tooltip reuses `buildCommitTooltip`. Both inline and status bar share `BlameService` for data — changes to caching or parsing belong there.
