import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
				const current = ctx.ui.theme?.name ?? "(unknown)";
				ctx.ui.notify(
					[
						`current: ${current}`,
						"",
						"curated themes (run `/tcc:theme <name>` to switch live):",
						...names.map((n) => `  - ${n}`),
						"",
						"`/tcc:theme save` persists the current pick across sessions.",
					].join("\n"),
					"info",
				);
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
