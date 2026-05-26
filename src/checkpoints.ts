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

type BranchMap = Record<string, CheckpointEntry>;
type CheckpointFile = Record<string, BranchMap>;

// Legacy file shape (pre per-branch) stored entries directly under the workflow name.
// Migration: such entries are bucketed under this synthetic branch key and remain
// available to every branch via the ancestor-inheritance lookup.
const LEGACY_BRANCH = "__legacy__";

function checkpointPath(cwd: string): string | undefined {
	const root = findGitRoot(cwd);
	return root ? join(root, ".tcc", "checkpoints.json") : undefined;
}

function readAll(cwd: string): CheckpointFile {
	const path = checkpointPath(cwd);
	if (!path) return {};
	const raw = readJson<Record<string, unknown>>(path, "checkpoints") ?? {};
	const out: CheckpointFile = {};
	for (const [name, value] of Object.entries(raw)) {
		if (value && typeof value === "object" && "sha" in value && typeof (value as { sha: unknown }).sha === "string") {
			out[name] = { [LEGACY_BRANCH]: value as CheckpointEntry };
		} else {
			out[name] = value as BranchMap;
		}
	}
	return out;
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

function currentBranch(cwd: string): string {
	try {
		const b = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
		if (b === "HEAD") {
			const sha = currentHead(cwd);
			return sha ? `detached:${sha.slice(0, 8)}` : "detached";
		}
		return b;
	} catch {
		return "unknown";
	}
}

function isAncestor(cwd: string, sha: string): boolean {
	try {
		execFileSync("git", ["-C", cwd, "merge-base", "--is-ancestor", sha, "HEAD"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const shortSha = (sha: string): string => sha.slice(0, 8);

interface ResolvedCheckpoint extends CheckpointEntry {
	branch: string;
	inherited: boolean;
}

function getCheckpoint(cwd: string, name: string): ResolvedCheckpoint | undefined {
	const byBranch = readAll(cwd)[name];
	if (!byBranch) return undefined;
	const branch = currentBranch(cwd);
	const own = byBranch[branch];
	if (own) return { ...own, branch, inherited: false };
	const candidates: ResolvedCheckpoint[] = [];
	for (const [b, entry] of Object.entries(byBranch)) {
		if (b === branch) continue;
		if (isAncestor(cwd, entry.sha)) candidates.push({ ...entry, branch: b, inherited: true });
	}
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => b.ts.localeCompare(a.ts));
	return candidates[0];
}

function setCheckpoint(
	cwd: string,
	name: string,
	explicitSha?: string,
): { sha: string; branch: string; path: string | undefined } | { error: string } {
	const sha = explicitSha ?? currentHead(cwd);
	if (!sha) return { error: "could not resolve HEAD — not inside a git repo?" };
	const all = readAll(cwd);
	const branch = currentBranch(cwd);
	if (!all[name]) all[name] = {};
	all[name][branch] = { sha, ts: new Date().toISOString() };
	return { sha, branch, path: writeAll(cwd, all) };
}

function buildSinceMessage(name: string, last: ResolvedCheckpoint | undefined, head: string): string {
	if (!last || last.sha === head) {
		return `Run /${name} against the current working tree. After it finishes, call \`checkpoint_set\` with name='${name}' to record HEAD (${shortSha(head)}) as the last-${name} checkpoint.`;
	}
	const provenance = last.inherited ? ` (inherited from branch '${last.branch}')` : "";
	return [
		`Run /${name} but the diff to review is *from the last ${name} checkpoint${provenance} to HEAD*:`,
		``,
		`  git diff ${shortSha(last.sha)}..HEAD`,
		``,
		`Use that diff (and the file list it produces) as the scope — do not look at the working tree, and ignore the default "git diff" instruction inside the skill. The relevant commit range is ${shortSha(last.sha)}..${shortSha(head)}.`,
		``,
		`After the review is complete, call \`checkpoint_set\` with name='${name}' to advance the checkpoint to HEAD (${shortSha(head)}). Do not advance it if the review surfaced unresolved blockers.`,
	].join("\n");
}

export default function checkpointsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "checkpoint_get",
		label: "Get checkpoint",
		description:
			"Return the last recorded SHA + timestamp for a named workflow checkpoint (e.g., 'simplify', 'security-review') on the current branch. " +
			"If the current branch has no checkpoint, falls back to the most recent checkpoint from another branch that's an ancestor of HEAD. " +
			"Use this when the user asks to do something 'since last time' or when running /tcc:since.",
		parameters: Type.Object({
			name: Type.String({ description: "Checkpoint name, e.g. 'simplify'." }),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const entry = getCheckpoint(ctx.cwd, params.name);
			let text: string;
			if (!entry) {
				text = `no '${params.name}' checkpoint recorded for branch '${currentBranch(ctx.cwd)}'`;
			} else {
				const provenance = entry.inherited ? ` (inherited from '${entry.branch}')` : ` (branch '${entry.branch}')`;
				text = `${params.name}: ${entry.sha} (recorded ${entry.ts})${provenance}`;
			}
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "checkpoint_set",
		label: "Set checkpoint",
		description:
			"Record the current git HEAD as the named workflow checkpoint for the current branch. Call this after completing a workflow (e.g., one-last-pass, security-review) so future /tcc:since invocations can scope to changes after this point. " +
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
			return {
				content: [{ type: "text", text: `checkpoint '${params.name}' [${result.branch}] = ${shortSha(result.sha)} → ${result.path}` }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("tcc:since", {
		description: "Re-run a workflow (e.g. /tcc:since one-last-pass) against only the changes since the last checkpoint on this branch.",
		handler: async (args, ctx: ExtensionContext) => {
			const name = (args.trim() || "one-last-pass").split(/\s+/)[0];
			const head = currentHead(ctx.cwd);
			if (!head) {
				ctx.ui.notify(`/tcc:since '${name}': not inside a git repo`, "error");
				return;
			}
			pi.sendUserMessage(buildSinceMessage(name, getCheckpoint(ctx.cwd, name), head));
		},
	});

	pi.registerCommand("tcc:checkpoint", {
		description: "Show or set a workflow checkpoint for the current branch. Usage: /tcc:checkpoint [name [set]] — bare /tcc:checkpoint lists all.",
		handler: async (args, ctx: ExtensionContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				const all = readAll(ctx.cwd);
				const rows: Array<[string, string, CheckpointEntry]> = [];
				for (const [name, byBranch] of Object.entries(all)) {
					for (const [branch, entry] of Object.entries(byBranch)) rows.push([name, branch, entry]);
				}
				if (rows.length === 0) {
					ctx.ui.notify("no checkpoints recorded for this repo", "info");
					return;
				}
				rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
				const lines = ["Checkpoints:"];
				for (const [name, branch, e] of rows) {
					const branchLabel = branch === LEGACY_BRANCH ? "(legacy)" : branch;
					lines.push(`  ${name.padEnd(20)} ${branchLabel.padEnd(24)} ${shortSha(e.sha)}  (${e.ts})`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			const [name, action] = parts;
			if (action === "set") {
				const result = setCheckpoint(ctx.cwd, name);
				ctx.ui.notify(
					"error" in result ? result.error : `checkpoint '${name}' [${result.branch}] = ${shortSha(result.sha)}`,
					"error" in result ? "error" : "info",
				);
				return;
			}
			const entry = getCheckpoint(ctx.cwd, name);
			if (!entry) {
				ctx.ui.notify(`no '${name}' checkpoint for branch '${currentBranch(ctx.cwd)}'`, "info");
				return;
			}
			const provenance = entry.inherited ? ` (inherited from '${entry.branch}')` : ` [${entry.branch}]`;
			ctx.ui.notify(`${name}${provenance}: ${shortSha(entry.sha)}  (${entry.ts})`, "info");
		},
	});
}
