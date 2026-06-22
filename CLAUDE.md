# fuzdev.tsv-format

> VSCode extension: format-on-save for TypeScript/JS, Svelte, and CSS,
> backed by tsv (`@fuzdev/tsv_format_wasm`). Scoped deliberately to **just
> formatting** — one canonical, non-configurable style.

**Status**: v1 implemented — builds both hosts, smoke-tested, packages to a
`.vsix`. Marketplace id is `fuzdev.tsv-format` (the manifest `name` must be
hyphenated — VSCode forbids `_` in extension names; the `displayName` is free
text).

Registers a single synchronous `DocumentFormattingEditProvider` and relies on
VSCode's built-in `editor.formatOnSave`; the extension never listens for save
events itself. tsv is non-configurable, so the extension exposes no settings.
Targets both the Node host (desktop / VSCode Server / remote) and the web host
(vscode.dev / github.dev).

It honors the same ignore files the CLI does, via the `IgnoreStack` export from
`@fuzdev/tsv_format_wasm` — the same matcher, in the CLI's two regimes keyed on
`.git`. **Inside a repo** (a `<folder>/.git` exists): `.gitignore`
**hierarchically** (one per directory, git-faithful) + `.formatignore`
**hierarchically** + a repo-root `.prettierignore` shadowed by a repo-root
`.formatignore`; tsv layers apply after `.gitignore`, so a `!` re-includes.
**Outside a repo**: only `.formatignore` (hierarchically); `.gitignore` /
`.prettierignore` are not read — exactly as the CLI does. It skips ignored files
on save **and** on explicit "Format Document": the provider can't tell the two
apart, and a save-hook would break the sync design, so both skip — matching
prettier-vscode. The ignore files are the one config input; they govern *which*
files format, never *how*.

The **workspace folder is treated as the eval root** (the common case where it is
the repo root). The CLI walks up to the `.git` repo root; the extension does not —
ignore files in ancestors *above* an opened subdirectory are out of scope (and
unwatchable from within the folder), so `in_repo` is just "`<folder>/.git`
exists". A subdir-opened repo therefore falls back to the loose regime
(`.formatignore` + heuristic, no `.gitignore`) — the conservative side (it skips
more, never formats build output the CLI would skip).

To match "skip exactly what `tsv format` skips," the extension defers the **whole**
directory-prune decision — both the per-file ancestor *walk* and the prune *verdict*
— to the shared `IgnoreStack.is_path_pruned(rel)` (the tsv workspace's
`tsv_discover` crate). Given the per-document stack, that one call walks `rel`'s
ancestor directories, reconstructs each level's heuristic state from the stack's own
pushed `.gitignore` anchors, and applies the safety nets
(`.git`/`node_modules`/`.hg`/`.svn`/`.jj`), the build-output heuristic
(`dist`/`build`/`target` + hidden dirs with its `!`-re-include override), and the
matcher. So the extension **no longer rebuilds any of that in TypeScript** — not the
walk, and not the `heuristic_active` state machine it used to thread by hand (the one
shared-policy seam it previously kept; it briefly used the per-directory
`classify_dir` for this before `is_path_pruned` existed). The skip check is just
`is_ignored(rel, false) || is_path_pruned(rel)`. (`classify_dir` stays the CLI's
per-directory primitive for a real top-down walk; the extension has none.)

## Layout

- `src/format_provider.ts` — host-agnostic core: the provider, languageId →
  `format_*` dispatch (ts/js/css/svelte only), `.svelte` extension fallback,
  status-bar + `tsv` Output channel for parse failures, and the gitignore-aware
  skip logic. Per workspace folder it caches `{in_repo, gitignores, formatignores,
  prettierignore}` — the `.gitignore` / `.formatignore` texts keyed by directory
  (found via `findFiles`, plus an explicit folder-root read since `**/` misses
  depth 0), the repo-root `.prettierignore`, and the `.git` regime flag — prebuilt
  off the save path and refreshed via a `FileSystemWatcher` over
  `**/.{gitignore,prettierignore,formatignore}`. On save it assembles a
  per-document `IgnoreStack` from that cache (synchronously), runs `is_ignored` +
  `is_path_pruned`, and frees it, so the provider stays synchronous. Activation
  **awaits** that initial load before registering the provider, closing the
  startup window where a save could beat the cache; a `findFiles` rejection there
  (likeliest on the web host's virtual FS) is caught and logged, degrading to the
  folder-root ignore files plus the always-on safety-net/heuristic pruning — never
  aborting activation or formatting everything.
- `src/extension.node.ts` — Node entry; WASM inits synchronously at import.
- `src/extension.web.ts` — web entry; reads the bundled `.wasm` via
  `context.extensionUri` + `workspace.fs` and `await init(bytes)` once.
- `esbuild.js` — dual CJS build; copies `tsv_wasm_bg.wasm` next to each bundle.

## Committing

`git add` and `git commit` are denied by `.claude/settings.local.json` in this
repo — make the edits and stop, the user commits.

## Build & publish

- TypeScript extension, bundled with esbuild as **CommonJS** for two targets:
  `main` (Node host) and `browser` (web host). Output stays CJS because the web
  Worker extension host still can't load ESM (Node-host ESM landed in 1.100, but
  not the web Worker host) — so `import.meta.url` is dead in both bundles and the
  WASM is loaded explicitly rather than via the package's `new URL(import.meta.url)`
  path. The Node build shims `import.meta.url` to the bundle's own file URL so the
  package's import-time `readFileSync` finds the copied `.wasm`.
- `npm run build` (production) / `npm run watch` / `npm run check` (typecheck +
  build + the `test/run.js` smoke test). `npm run package` builds + runs `npx
  @vscode/vsce package` (vsce is not a dependency — it's invoked transiently).
- Single runtime dependency: `@fuzdev/tsv_format_wasm` — the format-only tsv WASM
  (the smallest of the three variants). Dev deps: esbuild, typescript,
  @types/node (24.x, matching the host), @types/vscode (pinned to the
  `engines.vscode` floor, not latest).
- Published to the VSCode Marketplace (`vsce`) and Open VSX (`ovsx`). Version
  bumps and publishing are the maintainer's responsibility.
