import { join } from "node:path";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import { userConfigDir } from "./config.ts";
import { enumerateAllPlugins } from "./plugins.ts";
import { readJson, writeJsonAtomic } from "./util.ts";

const CONFIG_PATH = join(userConfigDir(), "config.json");

function setEnabled(id: string, enabled: boolean): void {
	const cfg = readJson<{ enabledPlugins?: Record<string, boolean> }>(CONFIG_PATH) ?? {};
	cfg.enabledPlugins = cfg.enabledPlugins ?? {};
	if (enabled) {
		// Defaults to true, so clearing the explicit-false entry is cleaner than writing `true`.
		delete cfg.enabledPlugins[id];
	} else {
		cfg.enabledPlugins[id] = false;
	}
	writeJsonAtomic(CONFIG_PATH, cfg);
}

async function openPicker(ctx: ExtensionContext): Promise<void> {
	const plugins = await enumerateAllPlugins();
	if (plugins.length === 0) {
		ctx.ui.notify("No plugins discovered. Add a marketplace to ~/.tcc/config.json first.", "info");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("/tcc:plugin: no UI available (headless mode). Use /tcc:plugin list / enable / disable instead.", "error");
		return;
	}

	// pending[id] = desired enabled state; only ids the user toggled appear here.
	const pending = new Map<string, boolean>();

	const items = plugins.map((p) => ({
		id: p.id,
		label: p.id,
		description: p.description?.split("\n")[0].slice(0, 120) ?? "(no description)",
		currentValue: p.enabled ? "enabled" : "disabled",
		values: ["enabled", "disabled"],
	}));

	await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
		return new SettingsList(
			items,
			Math.min(items.length, 15),
			getSettingsListTheme(),
			(id, newValue) => {
				pending.set(id, newValue === "enabled");
			},
			() => done(undefined),
		);
	});

	if (pending.size === 0) {
		ctx.ui.notify("no plugin changes", "info");
		return;
	}
	const enabled: string[] = [];
	const disabled: string[] = [];
	for (const [id, want] of pending) {
		const before = plugins.find((p) => p.id === id)?.enabled ?? true;
		if (want === before) continue; // toggled then toggled back
		setEnabled(id, want);
		(want ? enabled : disabled).push(id);
	}
	if (enabled.length === 0 && disabled.length === 0) {
		ctx.ui.notify("no net plugin changes", "info");
		return;
	}
	const parts: string[] = [];
	if (enabled.length > 0) parts.push(`enabled: ${enabled.join(", ")}`);
	if (disabled.length > 0) parts.push(`disabled: ${disabled.join(", ")}`);
	ctx.ui.notify(`${parts.join("; ")}. Restart tcc for changes to take effect.`, "info");
}

export default function pluginAdminExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:plugin", {
		description: "Toggle marketplace plugins via interactive checklist. Subcommands: list (plain text), enable <id>, disable <id> (scripting).",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();

			if (!sub) {
				await openPicker(ctx);
				return;
			}

			if (sub === "list") {
				const plugins = await enumerateAllPlugins();
				if (plugins.length === 0) {
					ctx.ui.notify("No plugins discovered. Add a marketplace to ~/.tcc/config.json first.", "info");
					return;
				}
				const nameWidth = Math.max(...plugins.map((p) => p.id.length));
				const lines = ["plugins (toggle with bare `/tcc:plugin` for the interactive picker):", ""];
				for (const p of plugins) {
					const flag = p.enabled ? "  enabled " : "  DISABLED";
					const desc = p.description ? ` — ${p.description.split("\n")[0].slice(0, 80)}` : "";
					lines.push(`${flag}  ${p.id.padEnd(nameWidth)}${desc}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "enable" || sub === "disable") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify(`/tcc:plugin ${sub}: missing plugin id (format: name@marketplace). Run /tcc:plugin list to see options.`, "error");
					return;
				}
				const plugins = await enumerateAllPlugins();
				const match = plugins.find((p) => p.id === id);
				if (!match) {
					const guess = plugins.find((p) => p.name === id);
					const hint = guess ? ` Did you mean '${guess.id}'?` : "";
					ctx.ui.notify(`/tcc:plugin ${sub}: no plugin with id '${id}' (use the full name@marketplace format).${hint}`, "error");
					return;
				}
				setEnabled(id, sub === "enable");
				ctx.ui.notify(`${sub}d '${id}'. Restart tcc for the change to take effect.`, "info");
				return;
			}

			ctx.ui.notify(`/tcc:plugin: unknown subcommand '${sub}'. Try: (bare) | list | enable <id> | disable <id>`, "error");
		},
	});
}
