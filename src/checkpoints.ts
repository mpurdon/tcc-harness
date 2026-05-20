import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findGitRoot } from "./config.ts";
import { readJson, writeJsonAtomic } from "./util.ts";

interface CheckpointEntry {
	sha: string;
	ts: string;
}

type CheckpointFile = Record<string, CheckpointEntry>;

function checkpointPath(cwd: string): string | undefined {
	const root = findGitRoot(cwd);
	return root ? join(root, ".tcc", "checkpoints.json") : undefined;
}

function readAll(cwd: string): CheckpointFile {
	const path = checkpointPath(cwd);
	if (!path) return {};
	return readJson<CheckpointFile>(path, "checkpoints") ?? {};
}

function writeAll(cwd: string, data: CheckpointFile): string | undefined {
	const path = checkpointPath(cwd);
	if (!path) return undefined;
	mkdirSync(join(path, ".."), { recursive: true });
	writeJsonAtomic(path, data);
	return path;
}

function currentHead(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

const shortSha = (sha: string): string => sha.slice(0, 8);

function setCheckpoint(cwd: string, name: string, explicitSha?: string): { sha: string; path: string | undefined } | { error: string } {
	const sha = explicitSha ?? currentHead(cwd);
	if (!sha) return { error: "could not resolve HEAD — not inside a git repo?" };
	const all = readAll(cwd);
	all[name] = { sha, ts: new Date().toISOString() };
	return { sha, path: writeAll(cwd, all) };
}

function buildSinceMessage(name: string, lastSha: string | undefined, head: string): string {
	if (!lastSha || lastSha === head) {
		return `Run /${name} against the current working tree. After it finishes, call \`checkpoint_set\` with name='${name}' to record HEAD (${shortSha(head)}) as the last-${name} checkpoint.`;
	}
	return [
		`Run /${name} but the diff to review is *from the last ${name} checkpoint to HEAD*:`,
		``,
		`  git diff ${shortSha(lastSha)}..HEAD`,
		``,
		`Use that diff (and the file list it produces) as the scope — do not look at the working tree, and ignore the default "git diff" instruction inside the skill. The relevant commit range is ${shortSha(lastSha)}..${shortSha(head)}.`,
		``,
		`After the review is complete, call \`checkpoint_set\` with name='${name}' to advance the checkpoint to HEAD (${shortSha(head)}). Do not advance it if the review surfaced unresolved blockers.`,
	].join("\n");
}

export default function checkpointsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "checkpoint_get",
		label: "Get checkpoint",
		description:
			"Return the last recorded SHA + timestamp for a named workflow checkpoint (e.g., 'simplify', 'security-review'). " +
			"Use this when the user asks to do something 'since last time' or when running /tcc:since.",
		parameters: Type.Object({
			name: Type.String({ description: "Checkpoint name, e.g. 'simplify'." }),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const entry = readAll(ctx.cwd)[params.name];
			const text = entry ? `${params.name}: ${entry.sha} (recorded ${entry.ts})` : `no '${params.name}' checkpoint recorded yet`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "checkpoint_set",
		label: "Set checkpoint",
		description:
			"Record the current git HEAD as the named workflow checkpoint. Call this after completing a workflow (e.g., one-last-pass, security-review) so future /tcc:since invocations can scope to changes after this point. " +
			"Pass sha to record an explicit commit instead of HEAD.",
		parameters: Type.Object({
			name: Type.String(),
			sha: Type.Optional(Type.String({ description: "Explicit SHA. Defaults to current git HEAD." })),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const result = setCheckpoint(ctx.cwd, params.name, params.sha);
			if ("error" in result) {
				return { content: [{ type: "text", text: result.error }], details: undefined, isError: true };
			}
			return { content: [{ type: "text", text: `checkpoint '${params.name}' = ${shortSha(result.sha)} → ${result.path}` }], details: undefined };
		},
	});

	pi.registerCommand("tcc:since", {
		description: "Re-run a workflow (e.g. /tcc:since one-last-pass) against only the changes since the last checkpoint.",
		handler: async (args, ctx: ExtensionContext) => {
			const name = (args.trim() || "one-last-pass").split(/\s+/)[0];
			const head = currentHead(ctx.cwd);
			if (!head) {
				ctx.ui.notify(`/tcc:since '${name}': not inside a git repo`, "error");
				return;
			}
			pi.sendUserMessage(buildSinceMessage(name, readAll(ctx.cwd)[name]?.sha, head));
		},
	});

	pi.registerCommand("tcc:checkpoint", {
		description: "Show or set a workflow checkpoint. Usage: /tcc:checkpoint [name [set]] — bare /tcc:checkpoint lists all.",
		handler: async (args, ctx: ExtensionContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				const entries = Object.entries(readAll(ctx.cwd));
				if (entries.length === 0) {
					ctx.ui.notify("no checkpoints recorded for this repo", "info");
					return;
				}
				const lines = ["Checkpoints:"];
				for (const [name, e] of entries.sort()) lines.push(`  ${name.padEnd(20)} ${shortSha(e.sha)}  (${e.ts})`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			const [name, action] = parts;
			if (action === "set") {
				const result = setCheckpoint(ctx.cwd, name);
				ctx.ui.notify("error" in result ? result.error : `checkpoint '${name}' = ${shortSha(result.sha)}`, "error" in result ? "error" : "info");
				return;
			}
			const entry = readAll(ctx.cwd)[name];
			ctx.ui.notify(entry ? `${name}: ${shortSha(entry.sha)}  (${entry.ts})` : `no '${name}' checkpoint`, "info");
		},
	});
}
