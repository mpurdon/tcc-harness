import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { triggerRecap } from "./recap.ts";
import { getSessionDollars } from "./usage.ts";
import { fmtDollars } from "./util.ts";

// Keyboard shortcuts for tcc commands. Configurable via ~/.tcc/config.json:
//   "shortcuts": { "recap": "ctrl+shift+r", "cost": "ctrl+shift+k", "context": "ctrl+shift+u" }
//
// Default: ctrl+shift+r → recap only (safe combo unlikely to conflict with pi's editor).
// Set any key to null/empty in config to disable that shortcut.

type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];

function isValidKey(s: string | undefined): s is ShortcutKey {
	return typeof s === "string" && s.length > 0;
}

function actionCost(ctx: ExtensionContext): void {
	const dollars = getSessionDollars();
	ctx.ui.notify(dollars > 0 ? `session cost: ${fmtDollars(dollars)}` : "no cost tracked yet", "info");
}

function actionContext(ctx: ExtensionContext): void {
	const usage = ctx.getContextUsage();
	if (!usage) {
		ctx.ui.notify("context usage unavailable", "info");
		return;
	}
	const pct = usage.percent != null ? `${Math.round(usage.percent)}%` : "?%";
	const tokens =
		usage.tokens != null
			? ` (${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens)`
			: "";
	ctx.ui.notify(`context: ${pct}${tokens}`, "info");
}

export default function shortcutsExtension(pi: ExtensionAPI): void {
	const cfg = loadConfig().shortcuts ?? {};

	// Each action: [configKey, defaultKey | undefined, handler]
	const bindings: [string, string | undefined, (ctx: ExtensionContext) => Promise<void> | void][] = [
		["recap", "ctrl+shift+r", (ctx) => triggerRecap(ctx)],
		["cost", undefined, actionCost],
		["context", undefined, actionContext],
	];

	for (const [key, defaultKey, handler] of bindings) {
		const raw = cfg[key as keyof typeof cfg] ?? defaultKey;
		if (!isValidKey(raw)) continue;
		pi.registerShortcut(raw as ShortcutKey, {
			description: `tcc: ${key}`,
			handler,
		});
	}
}
