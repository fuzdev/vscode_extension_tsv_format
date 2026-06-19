import type * as vscode from 'vscode';
import {format_css, format_svelte, format_typescript, IgnoreStack} from '@fuzdev/tsv_format_wasm';
import {activate_formatter, deactivate_formatter} from './format_provider.ts';

// Node extension host (desktop, VSCode Server, remote-SSH / WSL / Codespaces):
// the package's Node entry initializes WASM synchronously at import, so the
// formatters are ready the instant `activate` runs — no async step needed.
export const activate = (context: vscode.ExtensionContext): void => {
	activate_formatter(context, {format_css, format_svelte, format_typescript}, IgnoreStack);
};

export const deactivate = deactivate_formatter;
