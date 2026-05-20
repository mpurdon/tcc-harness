// Shared by scripts/init.mjs and scripts/mcp.mjs.
// src/cli-tools.ts has an equivalent TS implementation — keep them in sync.
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const cache = new Map();

export function which(cmd) {
	if (cache.has(cmd)) return cache.get(cmd);
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const p = join(dir, cmd);
		try {
			accessSync(p, constants.X_OK);
			cache.set(cmd, p);
			return p;
		} catch {
			// keep looking
		}
	}
	cache.set(cmd, undefined);
	return undefined;
}
