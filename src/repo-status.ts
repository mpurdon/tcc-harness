import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface RepoStatus {
	branch: string;
	ahead: number;
	behind: number;
	dirty: number;
	lastCommit: string;
}

function gitOut(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function readStatus(cwd: string): RepoStatus | undefined {
	const branch = gitOut(cwd, ["branch", "--show-current"]);
	if (branch === undefined) return undefined; // not a git repo

	let ahead = 0;
	let behind = 0;
	const aheadBehind = gitOut(cwd, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
	if (aheadBehind) {
		const parts = aheadBehind.split(/\s+/);
		behind = Number(parts[0]) || 0;
		ahead = Number(parts[1]) || 0;
	}

	const dirtyLines = gitOut(cwd, ["status", "--porcelain"]);
	const dirty = dirtyLines ? dirtyLines.split("\n").filter(Boolean).length : 0;

	const lastCommit = gitOut(cwd, ["log", "-1", "--format=%cr"]) ?? "no commits";

	return { branch: branch || "(detached)", ahead, behind, dirty, lastCommit };
}

function formatStatus(s: RepoStatus): string {
	const parts = [s.branch];
	if (s.ahead > 0) parts.push(`${s.ahead}↑`);
	if (s.behind > 0) parts.push(`${s.behind}↓`);
	if (s.dirty > 0) parts.push(`${s.dirty} dirty`);
	parts.push(`last commit ${s.lastCommit}`);
	return parts.join(" · ");
}

export default function repoStatusExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const status = readStatus(ctx.cwd);
		if (!status) return;
		const line = formatStatus(status);
		console.error(`[tcc repo] ${line}`);
		if (ctx.hasUI) ctx.ui.setStatus("tcc.repo", line);
	});
}
