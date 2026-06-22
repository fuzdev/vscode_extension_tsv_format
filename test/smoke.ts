// Smoke test for the gitignore-aware skip logic in `format_provider.ts`. Drives
// the REAL provider (with the real `IgnoreStack` WASM matcher) against a mock
// `vscode` + an in-memory file tree, across scenarios that mirror the native
// `tsv format` CLI. A supported, *unformatted* document yields edits when NOT
// ignored and none when ignored, so "no edits" ⟺ ignored. Run via `npm test`.
import {format_css, format_svelte, format_typescript, IgnoreStack} from '@fuzdev/tsv_format_wasm';
import {activate_formatter, deactivate_formatter} from '../src/format_provider.ts';
import * as vscode from 'vscode';

const FOLDER = '/repo';
const formatters = {format_css, format_svelte, format_typescript};
const make_context = () => ({subscriptions: [] as Array<{dispose(): void}>});

interface World {
	folder_path: string;
	files: Map<string, string>;
	dirs: Set<string>;
	// when set, the mock's `findFiles` rejects — simulating a web-host virtual-FS error
	find_files_throws?: boolean;
}

/** Build a world from a file spec; auto-derives parent dirs and (optionally) `.git`. */
const build_world = (
	files: Record<string, string>,
	is_repo: boolean,
	find_files_throws = false,
): World => {
	const fmap = new Map<string, string>();
	const dirs = new Set<string>([FOLDER]);
	for (const [rel, content] of Object.entries(files)) {
		fmap.set(`${FOLDER}/${rel}`, content);
		const parts = rel.split('/');
		parts.pop();
		let acc = FOLDER;
		for (const p of parts) {
			acc = `${acc}/${p}`;
			dirs.add(acc);
		}
	}
	if (is_repo) dirs.add(`${FOLDER}/.git`);
	return {folder_path: FOLDER, files: fmap, dirs, find_files_throws};
};

const UNFORMATTED_TS = 'const   x=1';
const UNFORMATTED_CSS = 'a{color:red}';
const UNFORMATTED_SVELTE = '<div   >x</div   >';

// typed accessors over the mock's test hooks
const set_world = (w: World): void =>
	(vscode as unknown as {__set_world(w: World): void}).__set_world(w);
const get_provider = (): {provideDocumentFormattingEdits(d: unknown): unknown[] | undefined} =>
	(
		vscode as unknown as {
			__get_provider(): {provideDocumentFormattingEdits(d: unknown): unknown[] | undefined};
		}
	).__get_provider();
const get_status = (): {visible: boolean; text: string} =>
	(vscode as unknown as {__get_status_item(): {visible: boolean; text: string}}).__get_status_item();
const fire_close = (doc: unknown): void =>
	(vscode as unknown as {__fire_close(d: unknown): void}).__fire_close(doc);

/** A minimal mock `TextDocument` for one path / language / content. */
const make_doc = (rel: string, languageId: string, content: string) => ({
	uri: vscode.Uri.file(`${FOLDER}/${rel}`),
	languageId,
	fileName: `${FOLDER}/${rel}`,
	getText: () => content,
	positionAt: (n: number) => ({line: 0, character: n}),
});

let pass = 0;
let fail = 0;
const check = (label: string, ignored: boolean, expected: boolean): void => {
	if (ignored === expected) pass++;
	else {
		fail++;
		console.log(`FAIL ${label} (ignored=${ignored}, want=${expected})`);
	}
};
const expect = (label: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`FAIL ${label}`);
	}
};

const run_scenario = async (
	name: string,
	files: Record<string, string>,
	is_repo: boolean,
	cases: Array<[string, string, boolean]>,
	find_files_throws = false,
): Promise<void> => {
	set_world(build_world(files, is_repo, find_files_throws));
	const ctx = make_context();
	// activation awaits the initial ignore-file load, so the cache is ready here
	await activate_formatter(ctx as never, formatters, IgnoreStack as never);
	const provider = get_provider();
	for (const [rel, languageId, expected] of cases) {
		const content =
			languageId === 'css'
				? UNFORMATTED_CSS
				: languageId === 'svelte'
					? UNFORMATTED_SVELTE
					: UNFORMATTED_TS;
		const edits = provider.provideDocumentFormattingEdits(make_doc(rel, languageId, content)) ?? [];
		check(`${name}: ${rel}`, edits.length === 0, expected);
	}
	deactivate_formatter();
};

// Dispatch + parse-error + status behavior, independent of the ignore files: a
// loose folder with no ignore files (nothing pruned), all docs at the root.
const run_dispatch_cases = async (): Promise<void> => {
	set_world(build_world({}, false));
	const ctx = make_context();
	await activate_formatter(ctx as never, formatters, IgnoreStack as never);
	const provider = get_provider();
	const status = get_status();
	const edits = (doc: unknown): unknown[] => provider.provideDocumentFormattingEdits(doc) ?? [];

	// supported + unformatted -> one full-document edit
	expect(
		'dispatch: ts unformatted -> edits',
		edits(make_doc('app.ts', 'typescript', UNFORMATTED_TS)).length === 1,
	);
	// already-formatted -> no edits (a clean file is never marked dirty)
	expect(
		'dispatch: ts already formatted -> no edits',
		edits(make_doc('app.ts', 'typescript', format_typescript(UNFORMATTED_TS))).length === 0,
	);
	// css dispatches too
	expect(
		'dispatch: css unformatted -> edits',
		edits(make_doc('app.css', 'css', UNFORMATTED_CSS)).length === 1,
	);
	// unsupported languageId, no extension fallback -> no edits
	expect(
		'dispatch: json unsupported -> no edits',
		edits(make_doc('data.json', 'json', UNFORMATTED_TS)).length === 0,
	);
	// `.svelte` extension fallback when the languageId isn't `svelte` (Svelte ext absent)
	expect(
		'dispatch: .svelte fallback -> edits',
		edits(make_doc('weird.svelte', 'plaintext', UNFORMATTED_SVELTE)).length === 1,
	);

	// parse error -> no edits (file left unchanged) + the status indicator is shown
	const bad = make_doc('bad.ts', 'typescript', 'const x = (');
	expect('dispatch: parse error -> no edits', edits(bad).length === 0);
	expect('dispatch: parse error -> status shown', status.visible && status.text.includes('tsv'));
	// closing the failing document clears the indicator
	fire_close(bad);
	expect('dispatch: close clears status', !status.visible);

	deactivate_formatter();
};

const main = async (): Promise<void> => {
	// 0. dispatch / parse-error / status behavior (not ignore-file related)
	await run_dispatch_cases();

	// 1. repo + .gitignore: gitignored dist/ skipped; non-gitignored build/ formatted
	//    (heuristic OFF in a repo with a .gitignore)
	await run_scenario(
		'gitignore prunes dist, heuristic off for build',
		{
			'.gitignore': 'dist/\n',
			'dist/out.ts': UNFORMATTED_TS,
			'build/src.ts': UNFORMATTED_TS,
			'src/app.ts': UNFORMATTED_TS,
		},
		true,
		[
			['dist/out.ts', 'typescript', true],
			['build/src.ts', 'typescript', false],
			['src/app.ts', 'typescript', false],
		],
	);

	// 2. .formatignore shadows .prettierignore (repo)
	await run_scenario(
		'formatignore shadows prettierignore',
		{
			'.prettierignore': 'p_only.ts\n',
			'.formatignore': 'generated/\n',
			'generated/skip.ts': UNFORMATTED_TS,
			'p_only.ts': UNFORMATTED_TS,
			'keep.ts': UNFORMATTED_TS,
		},
		true,
		[
			['generated/skip.ts', 'typescript', true],
			['p_only.ts', 'typescript', false],
			['keep.ts', 'typescript', false],
		],
	);

	// 3. hierarchical .gitignore re-include
	await run_scenario(
		'hierarchical gitignore re-include',
		{
			'.gitignore': '*.gen.ts\n',
			'sub/.gitignore': '!keep.gen.ts\n',
			'sub/keep.gen.ts': UNFORMATTED_TS,
			'sub/drop.gen.ts': UNFORMATTED_TS,
			'a.gen.ts': UNFORMATTED_TS,
		},
		true,
		[
			['sub/keep.gen.ts', 'typescript', false],
			['sub/drop.gen.ts', 'typescript', true],
			['a.gen.ts', 'typescript', true],
		],
	);

	// 4. hierarchical .formatignore (nested layer + deeper re-include)
	await run_scenario(
		'hierarchical formatignore',
		{
			'.formatignore': '*.snap.ts\n',
			'src/.formatignore': '!keep.snap.ts\n',
			'a.snap.ts': UNFORMATTED_TS,
			'src/keep.snap.ts': UNFORMATTED_TS,
			'src/drop.snap.ts': UNFORMATTED_TS,
		},
		true,
		[
			['a.snap.ts', 'typescript', true],
			['src/keep.snap.ts', 'typescript', false],
			['src/drop.snap.ts', 'typescript', true],
		],
	);

	// 5. loose (non-repo): .formatignore honored; .gitignore/.prettierignore NOT read;
	//    heuristic ON (build/dist/hidden skipped)
	await run_scenario(
		'loose: formatignore + heuristic, gitignore/prettierignore not read',
		{
			'.formatignore': 'gen/\n',
			'.gitignore': 'src/\n',
			'.prettierignore': 'keep.ts\n',
			'gen/out.ts': UNFORMATTED_TS,
			'src/app.ts': UNFORMATTED_TS,
			'build/b.ts': UNFORMATTED_TS,
			'dist/d.ts': UNFORMATTED_TS,
			'.hidden/h.ts': UNFORMATTED_TS,
			'keep.ts': UNFORMATTED_TS,
		},
		false,
		[
			['gen/out.ts', 'typescript', true],
			['src/app.ts', 'typescript', false],
			['build/b.ts', 'typescript', true],
			['dist/d.ts', 'typescript', true],
			['.hidden/h.ts', 'typescript', true],
			['keep.ts', 'typescript', false],
		],
	);

	// 6. loose: a .formatignore `!build/` re-includes over the heuristic
	await run_scenario(
		'loose: !build/ re-includes over heuristic',
		{
			'.formatignore': '!build/\n',
			'build/out.ts': UNFORMATTED_TS,
			'dist/d.ts': UNFORMATTED_TS,
			'src.ts': UNFORMATTED_TS,
		},
		false,
		[
			['build/out.ts', 'typescript', false],
			['dist/d.ts', 'typescript', true],
			['src.ts', 'typescript', false],
		],
	);

	// 7. safety nets: node_modules always skipped (repo)
	await run_scenario(
		'safety nets: node_modules skipped',
		{
			'.gitignore': '# nothing\n',
			'node_modules/pkg/index.ts': UNFORMATTED_TS,
			'src/app.css': UNFORMATTED_CSS,
		},
		true,
		[
			['node_modules/pkg/index.ts', 'typescript', true],
			['src/app.css', 'css', false],
		],
	);

	// 8. file under a gitignored directory is skipped (ancestor prune); svelte dispatch
	await run_scenario(
		'file under gitignored dir + svelte dispatch',
		{
			'.gitignore': 'vendored/\n',
			'vendored/v.svelte': '<div   >x</div   >',
			'app.svelte': '<div   >x</div   >',
		},
		true,
		[
			['vendored/v.svelte', 'svelte', true],
			['app.svelte', 'svelte', false],
		],
	);

	// 9. findFiles rejects (web-host virtual-FS error): activation must still
	//    succeed and the provider register. Degraded mode = the folder-root ignore
	//    files (read directly, not via findFiles) + the always-on safety-net /
	//    build-output pruning still apply; only NESTED ignore files are missed —
	//    never "format everything". (If activation rejected, this scenario would
	//    throw before any check ran.)
	await run_scenario(
		'findFiles rejects: root ignore + safety nets survive, nested missed',
		{
			'.gitignore': 'dist/\n',
			'sub/.gitignore': 'nested.ts\n',
			'dist/out.ts': UNFORMATTED_TS,
			'node_modules/pkg/index.ts': UNFORMATTED_TS,
			'sub/nested.ts': UNFORMATTED_TS,
			'src/app.ts': UNFORMATTED_TS,
		},
		true,
		[
			['dist/out.ts', 'typescript', true], // root .gitignore honored despite findFiles failing
			['node_modules/pkg/index.ts', 'typescript', true], // safety net always applies
			['sub/nested.ts', 'typescript', false], // nested .gitignore missed (degraded) -> formats
			['src/app.ts', 'typescript', false], // normal source
		],
		true,
	);

	console.log(`${pass} passed, ${fail} failed`);
	if (fail > 0) process.exit(1);
};

void main();
