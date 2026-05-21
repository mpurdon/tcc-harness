import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "./util.ts";

// Speculative git context: at session_start we kick off git status/log/diff in
// parallel (non-blocking). The results land in `cache` keyed by cwd. On the FIRST
// before_agent_start of the session for that cwd we inject the snapshot into the
// system prompt and mark it consumed — subsequent turns don't re-inject (would
// invalidate cache + bloat context). If the prefetch is still running when the
// first turn fires we await it briefly (capped); if not ready in time, we skip.

interface Snapshot {
	status: string;
	log: string;
	diffStat: string;
}

const cache = new Map<string, Promise<Snapshot | undefined>>();
const consumed = new Set<string>();
const PREFETCH_AWAIT_MS = 800;

async function captureSnapshot(cwd: string): Promise<Snapshot | undefined> {
	// `rev-parse` first — cheap, tells us if we're even in a git repo.
	const inRepo = await runProcess({ cmd: "git", args: ["rev-parse", "--is-inside-work-tree"], cwd, timeoutMs: 2_000 });
	if (inRepo.reason !== "exit" || inRepo.exitCode !== 0) return undefined;

	const [status, log, diffStat] = await Promise.all([
		runProcess({ cmd: "git", args: ["status", "--short"], cwd, timeoutMs: 3_000 }),
		runProcess({ cmd: "git", args: ["log", "-5", "--oneline"], cwd, timeoutMs: 3_000 }),
		runProcess({ cmd: "git", args: ["diff", "--stat"], cwd, timeoutMs: 3_000 }),
	]);

	const ok = (r: typeof status) => r.reason === "exit" && r.exitCode === 0;
	if (!ok(status) && !ok(log) && !ok(diffStat)) return undefined;

	return {
		status: ok(status) ? status.stdout.trim() : "",
		log: ok(log) ? log.stdout.trim() : "",
		diffStat: ok(diffStat) ? diffStat.stdout.trim() : "",
	};
}

function renderSnapshot(snap: Snapshot): string | undefined {
	const sections: string[] = [];
	if (snap.status) {
		// Cap status — large untracked dirs can explode this. ~25 lines is enough
		// for the model to know "you have a bunch of changes" without flooding.
		const lines = snap.status.split("\n");
		const shown = lines.slice(0, 25).join("\n");
		const trailer = lines.length > 25 ? `\n(+${lines.length - 25} more)` : "";
		sections.push(`### git status (short)\n${shown}${trailer}`);
	}
	if (snap.log) sections.push(`### git log (last 5)\n${snap.log}`);
	if (snap.diffStat) {
		const lines = snap.diffStat.split("\n");
		const shown = lines.slice(0, 20).join("\n");
		const trailer = lines.length > 20 ? `\n(+${lines.length - 20} more)` : "";
		sections.push(`### git diff --stat\n${shown}${trailer}`);
	}
	if (sections.length === 0) return undefined;
	return `## Repo snapshot (auto-injected on first turn)\n\n${sections.join("\n\n")}`;
}

async function waitWithCap<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	return await Promise.race([
		p,
		new Promise<undefined>((resolve) => {
			const t = setTimeout(() => resolve(undefined), ms);
			t.unref?.();
		}),
	]);
}

export default function predictiveContextExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// Fire-and-forget. The promise sits in `cache` for the first before_agent_start
		// to consume; failures swallow to undefined and just skip injection.
		if (!cache.has(ctx.cwd)) cache.set(ctx.cwd, captureSnapshot(ctx.cwd).catch(() => undefined));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const key = `${ctx.cwd}:${ctx.sessionManager.getSessionId()}`;
		if (consumed.has(key)) return;
		consumed.add(key);

		const pending = cache.get(ctx.cwd);
		if (!pending) return;
		const snap = await waitWithCap(pending, PREFETCH_AWAIT_MS);
		if (!snap) return;
		const block = renderSnapshot(snap);
		if (!block) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});
}
