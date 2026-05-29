import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findGitRoot, tccHome, userConfigDir } from "./config.ts";

// Rough token estimate. The model-reported total from getContextUsage() is
// authoritative; everything we compute ourselves is ~chars/4, the standard
// heuristic for English-ish text. Always labelled with "~" so nobody mistakes
// an estimate for a measured count.
function estTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

function fmtK(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function fmtN(n: number): string {
	return n.toLocaleString("en-US");
}

function bar(percent: number, width = 24): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

/** Char length of a file if it exists, else 0 — used to attribute the static
 *  (cached) portion of the system prompt to the sources TCC injects. */
function fileChars(path: string): number {
	try {
		if (!existsSync(path) || !statSync(path).isFile()) return 0;
		return readFileSync(path, "utf8").length;
	} catch {
		return 0;
	}
}

function firstExisting(paths: string[]): string | undefined {
	return paths.find((p) => existsSync(p));
}

interface Contributor {
	label: string;
	chars: number;
}

// The files TCC folds into the system prompt. Measuring them answers the most
// common "why is my cached prompt so big" question. Not exhaustive (pi also
// walks AGENTS.md/CLAUDE.md), so it's framed as "largest known contributors".
function staticContributors(cwd: string): Contributor[] {
	const root = findGitRoot(cwd) ?? cwd;
	const out: Contributor[] = [];

	const sysmd = join(tccHome(), "prompts", "system.md");
	out.push({ label: "prompts/system.md", chars: fileChars(sysmd) });

	out.push({ label: "~/.tcc/memory/MEMORY.md", chars: fileChars(join(userConfigDir(), "memory", "MEMORY.md")) });
	out.push({ label: "<repo>/.tcc/memory/MEMORY.md", chars: fileChars(join(root, ".tcc", "memory", "MEMORY.md")) });

	const ccMemory = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"), "memory", "MEMORY.md");
	out.push({ label: "claude-code MEMORY.md", chars: fileChars(ccMemory) });

	const todo = firstExisting([join(root, "TODO.md"), join(root, "TODOS.md"), join(root, "BACKLOG.md")]);
	out.push({ label: todo ? todo.replace(root, "<repo>") : "TODO.md", chars: todo ? fileChars(todo) : 0 });

	return out;
}

function handleContext(ctx: ExtensionCommandContext): void {
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const total = usage?.tokens ?? null;
	const percent = usage?.percent ?? (total !== null && window ? (total / window) * 100 : null);

	const modelName = ctx.model?.name ?? "(no model)";
	const lines: string[] = ["## tcc context"];
	lines.push(`${modelName} · window ${window ? fmtN(window) : "?"} tokens`);
	lines.push("");

	if (percent !== null) lines.push(bar(percent));
	if (total !== null) {
		const head = window ? ` · ${fmtN(Math.max(0, window - total))} headroom` : "";
		lines.push(`${fmtN(total)} / ${window ? fmtN(window) : "?"} tokens${percent !== null ? ` · ${percent.toFixed(0)}%` : ""}${head}`);
	} else {
		lines.push("(no model-reported usage yet — send a turn, or it resets right after compaction)");
	}
	lines.push("");

	// Composition: split the model-reported total into the static system prompt
	// (prompt-cached) and the conversation (grows each turn; what compaction trims).
	const sysChars = ctx.getSystemPrompt().length;
	const sysTokens = estTokens(sysChars);
	lines.push("Composition (estimated ~chars/4):");
	lines.push(`  system prompt   ~${fmtK(sysTokens).padEnd(7)} static, prompt-cached`);
	if (total !== null) {
		const convo = Math.max(0, total - sysTokens);
		lines.push(`  conversation    ~${fmtK(convo).padEnd(7)} grows each turn; compaction targets this`);
	}
	lines.push("");

	const contributors = staticContributors(ctx.cwd)
		.filter((c) => c.chars > 0)
		.sort((a, b) => b.chars - a.chars);
	if (contributors.length > 0) {
		lines.push("Largest static contributors (TCC-injected, est):");
		for (const c of contributors) lines.push(`  ${c.label.padEnd(30)} ~${fmtK(estTokens(c.chars))}`);
		lines.push("");
	}

	lines.push('Trim: /tcc:compact-then "<focus>" or /compact · cache hits in /tcc:cost');
	ctx.ui.notify(lines.join("\n"), "info");
}

export default function contextExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:context", {
		description: "Show context-window usage: total, static system prompt vs conversation, and the largest TCC-injected contributors.",
		handler: async (_args, ctx) => {
			handleContext(ctx);
		},
	});
}
