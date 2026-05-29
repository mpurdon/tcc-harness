import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pluginsCacheDir } from "./config.ts";

// Marketplace clones drop a .tcc-fetch-stamp whose mtime gates the 1h upstream
// refresh (see plugins.ts). Deleting them makes the next load re-pull from
// upstream instead of serving the cached clone — what `--plugins` is for.
function clearFetchStamps(): number {
	const root = pluginsCacheDir();
	if (!existsSync(root)) return 0;
	let cleared = 0;
	for (const entry of readdirSync(root)) {
		const stamp = join(root, entry, ".tcc-fetch-stamp");
		try {
			if (existsSync(stamp) && statSync(stamp).isFile()) {
				rmSync(stamp);
				cleared++;
			}
		} catch {
			// best-effort — a stamp we can't remove just means that marketplace
			// won't force-refresh; the local reload below still happens.
		}
	}
	return cleared;
}

export default function reloadExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:reload", {
		description: "Reload extensions, skills, prompts, and themes without restarting. Pass --plugins to also re-fetch marketplace plugins from upstream.",
		handler: async (args, ctx) => {
			const forcePlugins = /\b(--plugins|--fetch|-p)\b/.test(args);
			let note = "reloading extensions, skills, prompts, and themes…";
			if (forcePlugins) {
				const cleared = clearFetchStamps();
				note += `\ncleared ${cleared} marketplace fetch stamp${cleared === 1 ? "" : "s"} — plugins will re-fetch from upstream`;
			} else {
				note += "\n(local edits to SKILL.md / commands picked up; pass --plugins to re-fetch marketplaces from upstream)";
			}
			// Notify before reload: ctx is torn down and rebuilt by reload(), so a
			// post-reload notify would run against a stale context.
			ctx.ui.notify(note, "info");
			await ctx.reload();
		},
	});
}
