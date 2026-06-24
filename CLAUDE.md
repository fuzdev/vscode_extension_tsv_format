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
  `format_*` dispatch (ts/js/css/svelte only), `.svelte` fileName fallback (now
  defensive — the manifest `contributes.languages` owns the `.svelte` → `svelte`
  association, so the id is present even without the Svelte extension),
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
- `icon.png` — 128×128 marketplace icon (`package.json` `icon`); shipped in the
  `.vsix` (not excluded by `.vscodeignore`).

## Manifest shape

Beyond `main`/`browser`/`activationEvents`, the manifest carries:

- `contributes.languages` — declares the `.svelte` → `svelte` association, so a
  `.svelte` file gets the `svelte` languageId (and fires `onLanguage:svelte`)
  **without** the Svelte extension. VSCode core ships no `.svelte` association —
  only the Svelte extension does — so without this, `onLanguage:svelte` would
  never fire for a lone `.svelte` file and the provider would never activate.
  Language contributions merge by id, so this coexists with the Svelte extension
  (adds nothing when it's present). The `{pattern: '**/*.svelte'}` selector and
  the `.svelte` fileName fallback are now redundant backstops.
- `capabilities.untrustedWorkspaces.supported: true` — format-on-save must keep
  working in a Restricted-Mode (untrusted) workspace, the default for a freshly
  opened/cloned folder. Safe to declare: tsv is non-configurable, runs no
  project-supplied code, and reads ignore files as data only.
- `capabilities.virtualWorkspaces: true` — explicit support for the web host's
  virtual workspaces (vscode.dev / github.dev), matching the `browser` entry.

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

### Publishing & updating

The runtime dependency is **vendored into the bundle**: esbuild inlines
`@fuzdev/tsv_format_wasm` and copies its `.wasm` into `dist/{node,web}/`, and
`.vscodeignore` excludes `node_modules/**`. So the `.vsix` ships whatever WASM is
in `node_modules` *at build time* — the published extension does not resolve the
dependency at install time. Two consequences:

- **The dependency must be published before the extension is.** `package.json`
  pins `@fuzdev/tsv_format_wasm@^0.2.0` (for `is_path_pruned`), but only `0.1.0`
  is on the registry until tsv ships v0.2. Until then a clean `npm ci` / `npm
  install` **fails** (`ETARGET`, no matching `^0.2.0`), and the only working tree
  is one with a locally-built WASM linked into `node_modules` — which reports
  `0.1.0` but contains `is_path_pruned`. Building/publishing the `.vsix` from that
  tree ships an unpublished WASM. **Before the marketplace publish:** confirm tsv
  v0.2 is on the registry, then run a clean `npm install` so `package-lock.json`
  resolves `^0.2.0` from the registry (the lock is otherwise stale at `^0.1.0`)
  and the bundled WASM has published provenance. The go/no-go check is "`npm ci`
  succeeds against the registry."
- **Updating the formatter = rebuild, not a user dependency bump.** To pick up a
  new tsv release, bump the `@fuzdev/tsv_format_wasm` range, `npm install`, `npm
  run check`, then re-`package`/publish. There is no runtime auto-update of the
  formatter — its version is frozen into each `.vsix`.

Publish flow (maintainer-owned): `npm run check` → bump `version` → `npm run
package` (or `vsce publish`) for the Marketplace → `ovsx publish` for Open VSX.
Keep the published WASM in sync across both registries. The `engines.vscode`
floor (`^1.90.0`) and `@types/vscode` track the **minimum** supported host, not
latest; raise both together only when a newer host API is actually needed.

**Pre-publish checklist** (live confirmation, can't be driven headlessly):
desktop **multi-root** + the **web** host (vscode.dev / github.dev) — F5 via
`.vscode/launch.json` ("Run Extension (Desktop)" / "(Web)").
