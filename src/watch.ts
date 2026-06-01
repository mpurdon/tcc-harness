import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { playNotification } from "./notify.ts";
import { runProcess } from "./util.ts";

// Polling cadences chosen to be cheap (gh API rate limit is 5000/hr authenticated)
// while still feeling live. POLL_TICK_MS is how often we *consider* polling each
// watch; the per-watch interval determines whether it's actually due.
const POLL_TICK_MS = 5_000;
const RENDER_TICK_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const COMPLETED_LINGER_MS = 3 * 60_000;

type AutoStop = "mergeable";

type Kind = "pr" | "run";
type State = "active" | "completed" | "error";

interface Watch {
	id: string;
	kind: Kind;
	target: string;          // human display, e.g. "owner/repo#123" or "run 1234567890"
	queryArgs: string[];     // gh command args used to fetch status
	intervalMs: number;
	nextCheckAt: number;
	state: State;
	statusLine: string;      // short summary shown in the widget
	completedAt?: number;
	cwd: string;
	/** ISO timestamp of the most recent comment we've already notified about. PR-only.
	 *  Set to the time of the most recent comment on the first poll (so historical
	 *  comments don't generate notifications). */
	commentBaseline?: string;
	/** Opt-in heuristic that auto-flips a watch to completed before MERGED/CLOSED.
	 *  'mergeable' = state OPEN, mergeable MERGEABLE, no CHANGES_REQUESTED, all checks SUCCESS. */
	autoStop?: AutoStop;
}

function isReadyToMerge(pr: PrJson): boolean {
	if (pr.state !== "OPEN") return false;
	if (pr.mergeable !== "MERGEABLE") return false;
	if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") return false;
	const checks = pr.statusCheckRollup ?? [];
	return checks.length === 0 || checks.every((c) => (c.conclusion ?? c.state) === "SUCCESS");
}

const watches = new Map<string, Watch>();
let pollTimer: NodeJS.Timeout | undefined;
let renderTimer: NodeJS.Timeout | undefined;
let uiCtx: ExtensionContext | undefined;
const WIDGET_KEY = "tcc.watches";

function fmtCountdown(ms: number): string {
	if (ms <= 0) return "now";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function renderWidget(): void {
	if (!uiCtx) return;
	if (watches.size === 0) {
		uiCtx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	const now = Date.now();
	const lines = ["⏱  watches"];
	for (const w of watches.values()) {
		let trailer: string;
		if (w.state === "completed") {
			const clearsIn = (w.completedAt ?? now) + COMPLETED_LINGER_MS - now;
			trailer = `· clears in ${fmtCountdown(clearsIn)}`;
		} else if (w.state === "error") {
			trailer = `· next ${fmtCountdown(w.nextCheckAt - now)}`;
		} else {
			trailer = `· next ${fmtCountdown(w.nextCheckAt - now)}`;
		}
		lines.push(`  ${w.id.padEnd(14)} ${w.statusLine}  ${trailer}`);
	}
	uiCtx.ui.setWidget(WIDGET_KEY, lines);
}

function ensureTimers(): void {
	if (!pollTimer) {
		pollTimer = setInterval(() => {
			void pollTick();
		}, POLL_TICK_MS);
		pollTimer.unref?.();
	}
	if (!renderTimer) {
		renderTimer = setInterval(renderWidget, RENDER_TICK_MS);
		renderTimer.unref?.();
	}
}

function stopTimersIfIdle(): void {
	if (watches.size > 0) return;
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = undefined;
	}
	if (renderTimer) {
		clearInterval(renderTimer);
		renderTimer = undefined;
	}
	if (uiCtx) uiCtx.ui.setWidget(WIDGET_KEY, undefined);
}

async function pollTick(): Promise<void> {
	const now = Date.now();
	const due = [...watches.values()].filter((w) => w.state === "active" && w.nextCheckAt <= now);
	await Promise.all(due.map((w) => pollOne(w)));
	// Sweep completed watches past their linger.
	for (const w of watches.values()) {
		if (w.state === "completed" && w.completedAt && now - w.completedAt > COMPLETED_LINGER_MS) {
			watches.delete(w.id);
		}
	}
	if (watches.size === 0) {
		stopTimersIfIdle();
	} else {
		renderWidget();
	}
}

async function pollOne(w: Watch): Promise<void> {
	const result = await runProcess({ cmd: "gh", args: w.queryArgs, cwd: w.cwd, timeoutMs: 15_000 });
	w.nextCheckAt = Date.now() + w.intervalMs;
	if (result.reason !== "exit" || result.exitCode !== 0) {
		w.state = "error";
		w.statusLine = `error: ${(result.stderr || result.stdout || "gh failed").split("\n")[0].slice(0, 60)}`;
		return;
	}
	try {
		const parsed = JSON.parse(result.stdout);
		const summary = summarize(w.kind, parsed);
		const stateChanged = summary.statusLine !== w.statusLine && w.statusLine !== "";
		w.statusLine = summary.statusLine;
		if (summary.terminal && w.state === "active") {
			w.state = "completed";
			w.completedAt = Date.now();
			uiCtx?.ui.notify(`watch ${w.id}: ${summary.statusLine}`, "info");
			playNotification("done", `watch ${w.id}: ${summary.statusLine}`);
		} else if (w.kind === "pr" && w.autoStop === "mergeable" && w.state === "active" && isReadyToMerge(parsed as PrJson)) {
			w.state = "completed";
			w.completedAt = Date.now();
			uiCtx?.ui.notify(`watch ${w.id}: ✓ ready to merge (auto-stop)`, "info");
			playNotification("done", `watch ${w.id}: ready to merge`);
		} else if (stateChanged) {
			uiCtx?.ui.notify(`watch ${w.id}: ${summary.statusLine}`, "info");
		}
		// PR comments: notify on each comment newer than the baseline. First poll sets
		// the baseline so historical comments don't fire notifications.
		if (w.kind === "pr") {
			const comments = (parsed as PrJson).comments ?? [];
			const sorted = [...comments].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
			if (w.commentBaseline === undefined) {
				w.commentBaseline = sorted.at(-1)?.createdAt ?? "0";
			} else {
				const fresh = sorted.filter((c) => (c.createdAt ?? "") > (w.commentBaseline ?? ""));
				for (const c of fresh) {
					const snippet = (c.body ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
					const author = c.author?.login ?? "?";
					uiCtx?.ui.notify(`watch ${w.id} · new comment by @${author}: ${snippet}${(c.body ?? "").length > 120 ? "…" : ""}`, "info");
				}
				if (fresh.length > 0) w.commentBaseline = fresh.at(-1)?.createdAt ?? w.commentBaseline;
			}
		}
	} catch (err) {
		w.state = "error";
		w.statusLine = `parse error: ${(err as Error).message.slice(0, 60)}`;
	}
}

interface Summary {
	statusLine: string;
	terminal: boolean;
}

interface PrJson {
	state?: string;
	mergeable?: string;
	reviewDecision?: string;
	statusCheckRollup?: { state?: string; conclusion?: string; status?: string }[];
	comments?: { id?: string | number; body?: string; createdAt?: string; author?: { login?: string } }[];
}

interface RunJson {
	status?: string;
	conclusion?: string;
	name?: string;
}

function summarize(kind: Kind, json: unknown): Summary {
	if (kind === "pr") {
		const pr = json as PrJson;
		const state = pr.state ?? "?";
		if (state === "MERGED") return { statusLine: "✓ MERGED", terminal: true };
		if (state === "CLOSED") return { statusLine: "✗ CLOSED", terminal: true };
		const checks = pr.statusCheckRollup ?? [];
		const fail = checks.filter((c) => (c.conclusion ?? c.state) === "FAILURE").length;
		const pass = checks.filter((c) => (c.conclusion ?? c.state) === "SUCCESS").length;
		const pending = checks.filter((c) => {
			const s = c.conclusion ?? c.state ?? c.status;
			return s === "PENDING" || s === "IN_PROGRESS" || s === "QUEUED" || !s;
		}).length;
		const checksStr = checks.length === 0 ? "no checks" : `checks ${pass}✓/${fail}✗/${pending}⋯`;
		const review = pr.reviewDecision ? ` · ${pr.reviewDecision.toLowerCase().replace(/_/g, " ")}` : "";
		const mergeable = pr.mergeable === "CONFLICTING" ? " · CONFLICTS" : "";
		const commentCount = pr.comments?.length ?? 0;
		const commentStr = commentCount > 0 ? ` · 💬 ${commentCount}` : "";
		return { statusLine: `OPEN · ${checksStr}${review}${mergeable}${commentStr}`, terminal: false };
	}
	const run = json as RunJson;
	const status = (run.status ?? "?").toLowerCase();
	const conclusion = (run.conclusion ?? "").toLowerCase();
	const name = run.name ? `${run.name.slice(0, 30)}: ` : "";
	if (status === "completed") {
		const mark = conclusion === "success" ? "✓" : conclusion === "failure" ? "✗" : "·";
		return { statusLine: `${name}${mark} ${conclusion || "completed"}`, terminal: true };
	}
	return { statusLine: `${name}${status}`, terminal: false };
}

async function resolveRepoNwo(cwd: string): Promise<string | undefined> {
	const r = await runProcess({ cmd: "gh", args: ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd, timeoutMs: 5_000 });
	if (r.reason !== "exit" || r.exitCode !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

function addWatch(w: Watch): void {
	watches.set(w.id, w);
	ensureTimers();
	renderWidget();
	// First poll happens immediately so the user sees real status, not "pending…".
	void pollOne(w).then(() => renderWidget());
}

// Result shape shared by slash-command path and pi-tool path.
type AddResult = { ok: true; id: string; target: string } | { ok: false; error: string };

async function addPrWatch(prRef: string, cwd: string, autoStop?: AutoStop): Promise<AddResult> {
	let nwo: string | undefined;
	let num: string;
	const explicit = prRef.match(/^([^/]+\/[^#]+)#(\d+)$/);
	if (explicit) {
		nwo = explicit[1];
		num = explicit[2];
	} else if (/^\d+$/.test(prRef)) {
		nwo = await resolveRepoNwo(cwd);
		if (!nwo) return { ok: false, error: "not in a github repo; use the explicit owner/repo#num form" };
		num = prRef;
	} else {
		return { ok: false, error: `don't understand '${prRef}'; expected <num> or <owner>/<repo>#<num>` };
	}
	const id = `pr-${num}`;
	if (watches.has(id)) return { ok: false, error: `already watching ${id} (stop it first to refresh)` };
	addWatch({
		id,
		kind: "pr",
		target: `${nwo}#${num}`,
		queryArgs: ["pr", "view", num, "--repo", nwo, "--json", "state,mergeable,reviewDecision,statusCheckRollup,comments"],
		intervalMs: DEFAULT_POLL_INTERVAL_MS,
		nextCheckAt: Date.now() + DEFAULT_POLL_INTERVAL_MS,
		state: "active",
		statusLine: "polling…",
		cwd,
		autoStop,
	});
	return { ok: true, id, target: `${nwo}#${num}` };
}

function addRunWatch(runId: string, cwd: string): AddResult {
	if (!/^\d+$/.test(runId)) return { ok: false, error: `expected numeric run id, got '${runId}'` };
	const id = `run-${runId}`;
	if (watches.has(id)) return { ok: false, error: `already watching ${id}` };
	addWatch({
		id,
		kind: "run",
		target: `run ${runId}`,
		queryArgs: ["run", "view", runId, "--json", "status,conclusion,name"],
		intervalMs: DEFAULT_POLL_INTERVAL_MS,
		nextCheckAt: Date.now() + DEFAULT_POLL_INTERVAL_MS,
		state: "active",
		statusLine: "polling…",
		cwd,
	});
	return { ok: true, id, target: `run ${runId}` };
}

function stopWatch(id: string): boolean {
	const removed = watches.delete(id);
	if (removed) {
		stopTimersIfIdle();
		renderWidget();
	}
	return removed;
}

function listWatchesText(): string {
	if (watches.size === 0) return "no active watches";
	const now = Date.now();
	const lines = ["active watches:"];
	for (const w of watches.values()) {
		const next = w.state === "completed"
			? `clears in ${fmtCountdown((w.completedAt ?? now) + COMPLETED_LINGER_MS - now)}`
			: `next check in ${fmtCountdown(w.nextCheckAt - now)}`;
		lines.push(`  ${w.id.padEnd(14)} ${w.statusLine}  · ${next}`);
	}
	return lines.join("\n");
}

export default function watchExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		if (watches.size > 0) {
			ensureTimers();
			renderWidget();
		}
	});

	pi.registerCommand("tcc:watch", {
		description: "Watch GitHub PRs / workflow runs in the background. Usage: /tcc:watch pr <num>|run <id>|list|stop <id>.",
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase() ?? "list";

			if (sub === "list") {
				ctx.ui.notify(listWatchesText(), "info");
				return;
			}

			if (sub === "stop") {
				const id = parts[1];
				if (!id) return ctx.ui.notify("/tcc:watch stop: missing id (see /tcc:watch list)", "error");
				if (!stopWatch(id)) return ctx.ui.notify(`/tcc:watch stop: no watch '${id}'`, "error");
				ctx.ui.notify(`stopped ${id}`, "info");
				return;
			}

			if (sub === "pr") {
				const arg = parts[1];
				if (!arg) return ctx.ui.notify("/tcc:watch pr: usage `/tcc:watch pr <num> [mergeable]` (trailing 'mergeable' auto-stops once the PR is ready to merge)", "error");
				const autoStop = parts[2]?.toLowerCase() === "mergeable" ? "mergeable" : undefined;
				const result = await addPrWatch(arg, ctx.cwd, autoStop);
				if (!result.ok) return ctx.ui.notify(`/tcc:watch pr: ${result.error}`, "error");
				ctx.ui.notify(`watching ${result.target}${autoStop ? " (auto-stops when ready to merge)" : ""}`, "info");
				return;
			}

			if (sub === "run") {
				const arg = parts[1];
				if (!arg) return ctx.ui.notify("/tcc:watch run: usage `/tcc:watch run <run-id>` (numeric id)", "error");
				const result = addRunWatch(arg, ctx.cwd);
				if (!result.ok) return ctx.ui.notify(`/tcc:watch run: ${result.error}`, "error");
				ctx.ui.notify(`watching ${result.target}`, "info");
				return;
			}

			ctx.ui.notify(`/tcc:watch: unknown subcommand '${sub}'. Try: pr <num> | run <id> | list | stop <id>`, "error");
		},
	});

	pi.registerTool({
		name: "watch_pr",
		label: "Watch PR",
		description:
			"Start a background poller for a GitHub pull request. Reports state changes (merged/closed), CI check transitions, review decisions, and any new comments via UI notifications. The user sees a live widget with status and next-check countdown. Use this when the user asks to 'watch a PR', 'tell me when this PR is approved', 'let me know when CI passes', or 'notify me about comments'. Polls every 30s via `gh`. Pass autoStop='mergeable' when the user wants the watch to end as soon as the PR is ready to merge (rather than wait for the actual merge).",
		parameters: Type.Object({
			pr: Type.String({ description: "PR reference — bare number (e.g. '123') if in the relevant git repo, or 'owner/repo#num' for any repo." }),
			autoStop: Type.Optional(Type.String({ description: "Optional. Set to 'mergeable' to auto-stop the watch once the PR is OPEN, mergeable, has no outstanding CHANGES_REQUESTED/REVIEW_REQUIRED, and all checks pass. Default: watch until MERGED/CLOSED." })),
		}),
		async execute(_id, params, _signal, _u, ctx) {
			uiCtx = ctx;
			const autoStop = params.autoStop === "mergeable" ? "mergeable" : undefined;
			const r = await addPrWatch(params.pr, ctx.cwd, autoStop);
			if (!r.ok) return { content: [{ type: "text", text: `watch_pr: ${r.error}` }], details: undefined, isError: true };
			const trailer = autoStop ? " Will auto-stop once the PR is ready to merge." : "";
			return { content: [{ type: "text", text: `Now watching ${r.target} (id ${r.id}). The user will be notified on state changes, CI transitions, and new comments. They can also see live status in the widget above the editor.${trailer}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "watch_run",
		label: "Watch workflow run",
		description:
			"Start a background poller for a GitHub Actions workflow run. Reports when the run completes (success/failure/cancelled). The user sees a live widget with status and next-check countdown. Use this when the user asks to 'watch a deployment', 'tell me when CI finishes', or similar. Polls every 30s via `gh`.",
		parameters: Type.Object({
			runId: Type.String({ description: "Numeric workflow run id (from gh run list or the run URL)." }),
		}),
		async execute(_id, params, _signal, _u, ctx) {
			uiCtx = ctx;
			const r = addRunWatch(params.runId, ctx.cwd);
			if (!r.ok) return { content: [{ type: "text", text: `watch_run: ${r.error}` }], details: undefined, isError: true };
			return { content: [{ type: "text", text: `Now watching ${r.target} (id ${r.id}). The user will be notified when it completes.` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "watch_list",
		label: "List watches",
		description: "List all active and recently-completed PR/workflow-run watches with their current status and next-check countdown.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _u, _ctx) {
			return { content: [{ type: "text", text: listWatchesText() }], details: undefined };
		},
	});

	pi.registerTool({
		name: "watch_stop",
		label: "Stop watch",
		description: "Stop a background watch by id. Use watch_list first if you don't know the id (format: 'pr-<num>' or 'run-<id>').",
		parameters: Type.Object({
			id: Type.String({ description: "Watch id, e.g. 'pr-123' or 'run-9871234567'." }),
		}),
		async execute(_id, params, _signal, _u, _ctx) {
			if (!stopWatch(params.id)) return { content: [{ type: "text", text: `watch_stop: no watch with id '${params.id}'` }], details: undefined, isError: true };
			return { content: [{ type: "text", text: `Stopped watch '${params.id}'.` }], details: undefined };
		},
	});
}
