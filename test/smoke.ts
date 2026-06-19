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
}

/** Build a world from a file spec; auto-derives parent dirs and (optionally) `.git`. */
const build_world = (files: Record<string, string>, is_repo: boolean): World => {
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
	return {folder_path: FOLDER, files: fmap, dirs};
};

const flush = () => new Promise((r) => setTimeout(r, 0));
const UNFORMATTED_TS = 'const   x=1';
const UNFORMATTED_CSS = 'a{color:red}';

let pass = 0;
let fail = 0;
const check = (label: string, ignored: boolean, expected: boolean): void => {
	if (ignored === expected) pass++;
	else {
		fail++;
		console.log(`FAIL ${label} (ignored=${ignored}, want=${expected})`);
	}
};

const run_scenario = async (
	name: string,
	files: Record<string, string>,
	is_repo: boolean,
	cases: Array<[string, string, boolean]>,
): Promise<void> => {
	(vscode as unknown as {__set_world(w: World): void}).__set_world(build_world(files, is_repo));
	const ctx = make_context();
	activate_formatter(ctx as never, formatters, IgnoreStack as never);
	await flush(); // let the off-save-path reload populate the cache
	const provider = (
		vscode as unknown as {__get_provider(): {provideDocumentFormattingEdits(d: unknown): unknown[]}}
	).__get_provider();
	for (const [rel, languageId, expected] of cases) {
		const content = languageId === 'css' ? UNFORMATTED_CSS : UNFORMATTED_TS;
		const document = {
			uri: vscode.Uri.file(`${FOLDER}/${rel}`),
			languageId,
			fileName: `${FOLDER}/${rel}`,
			getText: () => content,
			positionAt: (n: number) => ({line: 0, character: n}),
		};
		const edits = provider.provideDocumentFormattingEdits(document) ?? [];
		check(`${name}: ${rel}`, edits.length === 0, expected);
	}
	deactivate_formatter();
};

const main = async (): Promise<void> => {
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

	console.log(`${pass} passed, ${fail} failed`);
	if (fail > 0) process.exit(1);
};

void main();
