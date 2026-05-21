import { readdirSync } from "node:fs";
import { join } from "node:path";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList } from "@earendil-works/pi-tui";
import { loadConfig, tccHome, userConfigDir } from "./config.ts";
import { readJson, writeJsonAtomic } from "./util.ts";

/** Names of themes we ship in ./themes/. Only these are offered via /tcc:theme;
 *  pi's built-ins (dark/light) are intentionally hidden. */
function curatedThemes(): string[] {
	try {
		return readdirSync(join(tccHome(), "themes"))
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.replace(/\.json$/, ""))
			.sort();
	} catch {
		return [];
	}
}

function resolveStartupTheme(): string | undefined {
	// Env var wins (lets users override per-shell); otherwise the persisted choice from /tcc:theme.
	return process.env.TCC_DEFAULT_THEME ?? loadConfig().theme;
}

function persistTheme(name: string): void {
	const path = join(userConfigDir(), "config.json");
	const existing = readJson<Record<string, unknown>>(path) ?? {};
	existing.theme = name;
	writeJsonAtomic(path, existing);
}

async function openThemePicker(ctx: ExtensionContext, names: string[]): Promise<void> {
	const current = ctx.ui.theme?.name;
	const items = names.map((n) => ({
		value: n,
		label: n === current ? `${n}  (current)` : n,
		description: "preview by selecting; Enter to apply",
	}));
	const picked = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
		const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
		// Live-preview as the user moves through the list so they can see each theme.
		list.onSelectionChange = (item) => {
			if (item.value !== ctx.ui.theme?.name) ctx.ui.setTheme(item.value);
		};
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		return list;
	});
	if (picked === undefined) {
		// User cancelled — restore the original theme if preview drifted off it.
		if (current && ctx.ui.theme?.name !== current) ctx.ui.setTheme(current);
		return;
	}
	if (picked === current) {
		ctx.ui.notify(`already on '${picked}'`, "info");
		return;
	}
	ctx.ui.notify(`theme → ${picked}. Run \`/tcc:theme save\` to persist.`, "info");
}

export default function themeExtension(pi: ExtensionAPI): void {
	const allowed = new Set(curatedThemes());

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const name = resolveStartupTheme();
		if (!name) return;
		const result = ctx.ui.setTheme(name);
		if (!result.success) {
			console.error(`[tcc] theme '${name}' could not be applied: ${result.error ?? "unknown error"}`);
		}
	});

	pi.registerCommand("tcc:theme", {
		description: "Switch theme live. Usage: /tcc:theme [name|save|reset] — bare /tcc:theme lists the curated set.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tcc:theme: no UI to repaint (headless mode)", "error");
				return;
			}
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = parts[0]?.toLowerCase();
			const names = [...allowed];
			if (names.length === 0) {
				ctx.ui.notify(`/tcc:theme: no curated themes found in ${join(tccHome(), "themes")}`, "error");
				return;
			}

			if (!cmd) {
				await openThemePicker(ctx, names);
				return;
			}

			if (cmd === "save") {
				const current = ctx.ui.theme?.name;
				if (!current) {
					ctx.ui.notify("/tcc:theme save: couldn't read current theme", "error");
					return;
				}
				persistTheme(current);
				ctx.ui.notify(`saved '${current}' to ~/.tcc/config.json (TCC_DEFAULT_THEME env var still overrides if set).`, "info");
				return;
			}

			if (cmd === "reset") {
				const path = join(userConfigDir(), "config.json");
				const existing = readJson<Record<string, unknown>>(path) ?? {};
				delete existing.theme;
				writeJsonAtomic(path, existing);
				ctx.ui.notify("cleared persisted theme. Next session uses TCC_DEFAULT_THEME or pi's default.", "info");
				return;
			}

			if (!allowed.has(cmd)) {
				ctx.ui.notify(`/tcc:theme: '${cmd}' is not in the curated set. Available: ${names.join(", ")}`, "error");
				return;
			}
			const result = ctx.ui.setTheme(cmd);
			if (!result.success) {
				ctx.ui.notify(`/tcc:theme: setTheme failed: ${result.error ?? "unknown error"}`, "error");
				return;
			}
			ctx.ui.notify(`theme → ${cmd}. Run \`/tcc:theme save\` to persist.`, "info");
		},
	});
}
