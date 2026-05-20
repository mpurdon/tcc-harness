import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export default function pluginAdminExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:plugin", {
		description: "Manage which marketplace plugins load. Usage: /tcc:plugin [list|enable <id>|disable <id>] — bare /tcc:plugin lists all.",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase() ?? "list";

			if (sub === "list") {
				const plugins = await enumerateAllPlugins();
				if (plugins.length === 0) {
					ctx.ui.notify(
						"No plugins discovered. Either no marketplaces are configured (see /tcc:plugin via ~/.tcc/config.json's `marketplaces`) or every marketplace failed to clone.",
						"info",
					);
					return;
				}
				const nameWidth = Math.max(...plugins.map((p) => p.id.length));
				const lines = ["plugins (write to ~/.tcc/config.json — restart required to take effect):", ""];
				for (const p of plugins) {
					const flag = p.enabled ? "  enabled " : "  DISABLED";
					const desc = p.description ? ` — ${p.description.split("\n")[0].slice(0, 80)}` : "";
					lines.push(`${flag}  ${p.id.padEnd(nameWidth)}${desc}`);
				}
				lines.push("", "Toggle with `/tcc:plugin disable <id>` or `/tcc:plugin enable <id>`.");
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

			ctx.ui.notify(`/tcc:plugin: unknown subcommand '${sub}'. Try: list | enable <id> | disable <id>`, "error");
		},
	});
}
