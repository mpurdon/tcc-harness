import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findGitRoot } from "./config.ts";

const CANDIDATES = ["TODO.md", "TODOS.md", "BACKLOG.md", "TODO", "ROADMAP.md"];
const MAX_LINES = 60;

function loadTodos(cwd: string): { path: string; body: string } | undefined {
	const root = findGitRoot(cwd);
	if (!root) return undefined;
	for (const name of CANDIDATES) {
		const path = join(root, name);
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const lines = raw.split("\n");
		const body = lines.length > MAX_LINES ? `${lines.slice(0, MAX_LINES).join("\n")}\n… (${lines.length - MAX_LINES} more lines truncated)` : raw;
		return { path, body: body.trim() };
	}
	return undefined;
}

const cache = new Map<string, { signature: string; rendered: string }>();

function render(cwd: string): string | undefined {
	const cached = cache.get(cwd);
	const todos = loadTodos(cwd);
	const signature = todos ? `${todos.path}:${todos.body.length}` : "";
	if (cached?.signature === signature) return cached.rendered || undefined;
	const rendered = todos ? `## Open work tracked in ${todos.path}\n\n${todos.body}` : "";
	cache.set(cwd, { signature, rendered });
	return rendered || undefined;
}

export default function todoExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		cache.delete(ctx.cwd);
	});

	// Cache-stable: render() is signature-cached on the TODO file's (path, length), so the
	// returned block is reference-equal as long as the file is untouched. Bedrock prompt
	// caching depends on this. Edits to TODO.md mid-session break the cache for one turn
	// (intentional — the model should see the new state). Don't inject anything that varies
	// per turn (timestamps, completion percentages, etc.) without a separate cache point.
	pi.on("before_agent_start", (event, ctx) => {
		const block = render(ctx.cwd);
		if (!block) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});
}
