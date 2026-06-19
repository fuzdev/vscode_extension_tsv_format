// Minimal mock of the `vscode` module for the smoke test (test/smoke.ts). Backed
// by an in-memory "world" (files + dirs under one workspace folder) set per
// scenario. findFiles deliberately mirrors VSCode's `**/` glob, which MISSES the
// folder-root file — so the provider's explicit-root-read fallback is exercised
// (the absence of which was a real bug this test caught).
'use strict';

let world = {folder_path: '/repo', files: new Map(), dirs: new Set()};
let captured_provider;

const enc = new TextEncoder();

class Uri {
	constructor(path) {
		this.path = path;
		this.fsPath = path;
		this.scheme = 'file';
	}
	toString() {
		return `file://${this.path}`;
	}
	static file(p) {
		return new Uri(p);
	}
	static joinPath(uri, ...parts) {
		return new Uri([uri.path, ...parts].join('/'));
	}
}

class RelativePattern {
	constructor(folder, pattern) {
		this.folder = folder;
		this.pattern = pattern;
	}
}

class Range {
	constructor(start, end) {
		this.start = start;
		this.end = end;
	}
}

const TextEdit = {
	replace(range, newText) {
		return {range, newText};
	},
};

const StatusBarAlignment = {Left: 1, Right: 2};

const folders = () => [{uri: Uri.file(world.folder_path), name: 'repo', index: 0}];

const workspace = {
	get workspaceFolders() {
		return folders();
	},
	getWorkspaceFolder(uri) {
		const f = folders()[0];
		return uri.path === f.uri.path || uri.path.startsWith(`${f.uri.path}/`) ? f : undefined;
	},
	async findFiles(relPattern, _exclude) {
		const name = relPattern.pattern.replace(/^\*\*\//, '');
		const root = relPattern.folder.uri.path;
		const out = [];
		for (const p of world.files.keys()) {
			if (!p.startsWith(`${root}/`)) continue;
			const rel = p.slice(root.length + 1);
			if (rel.includes('node_modules/')) continue;
			// `**/` requires at least one dir segment — root-level files are missed
			if (!rel.includes('/')) continue;
			if (rel.slice(rel.lastIndexOf('/') + 1) === name) out.push(Uri.file(p));
		}
		return out;
	},
	fs: {
		async stat(uri) {
			if (world.files.has(uri.path)) return {type: 1};
			if (world.dirs.has(uri.path)) return {type: 2};
			throw new Error(`ENOENT ${uri.path}`);
		},
		async readFile(uri) {
			const content = world.files.get(uri.path);
			if (content === undefined) throw new Error(`ENOENT ${uri.path}`);
			return enc.encode(content);
		},
	},
	createFileSystemWatcher() {
		const sub = () => ({dispose() {}});
		return {onDidCreate: sub, onDidChange: sub, onDidDelete: sub, dispose() {}};
	},
	onDidChangeWorkspaceFolders() {
		return {dispose() {}};
	},
	asRelativePath(uri) {
		return uri.path;
	},
};

const window = {
	createOutputChannel() {
		return {appendLine() {}, show() {}, dispose() {}};
	},
	createStatusBarItem() {
		return {text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {}};
	},
};

const commands = {
	registerCommand() {
		return {dispose() {}};
	},
};

const languages = {
	registerDocumentFormattingEditProvider(_selector, provider) {
		captured_provider = provider;
		return {dispose() {}};
	},
};

module.exports = {
	Uri,
	RelativePattern,
	Range,
	TextEdit,
	StatusBarAlignment,
	workspace,
	window,
	commands,
	languages,
	// test hooks
	__set_world(w) {
		world = w;
	},
	__get_provider() {
		return captured_provider;
	},
};
