import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runProcess } from "./util.ts";

// Polling cadences chosen to be cheap (gh API rate limit is 5000/hr authenticated)
// while still feeling live. POLL_TICK_MS is how often we *consider* polling each
// watch; the per-watch interval determines whether it's actually due.
const POLL_TICK_MS = 5_000;
const RENDER_TICK_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const COMPLETED_LINGER_MS = 5 * 60_000;

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
		} else if (stateChanged) {
			uiCtx?.ui.notify(`watch ${w.id}: ${summary.statusLine}`, "info");
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
		return { statusLine: `OPEN · ${checksStr}${review}${mergeable}`, terminal: false };
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
				if (watches.size === 0) {
					ctx.ui.notify("no active watches", "info");
					return;
				}
				const now = Date.now();
				const lines = ["active watches:"];
				for (const w of watches.values()) {
					const next = w.state === "completed"
						? `clears in ${fmtCountdown((w.completedAt ?? now) + COMPLETED_LINGER_MS - now)}`
						: `next check in ${fmtCountdown(w.nextCheckAt - now)}`;
					lines.push(`  ${w.id.padEnd(14)} ${w.statusLine}  · ${next}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "stop") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify("/tcc:watch stop: missing id (see /tcc:watch list)", "error");
					return;
				}
				if (!watches.delete(id)) {
					ctx.ui.notify(`/tcc:watch stop: no watch '${id}'`, "error");
					return;
				}
				stopTimersIfIdle();
				renderWidget();
				ctx.ui.notify(`stopped ${id}`, "info");
				return;
			}

			if (sub === "pr") {
				const arg = parts[1];
				if (!arg) {
					ctx.ui.notify("/tcc:watch pr: usage `/tcc:watch pr <num>` or `/tcc:watch pr <owner>/<repo>#<num>`", "error");
					return;
				}
				let nwo: string | undefined;
				let num: string;
				const explicit = arg.match(/^([^/]+\/[^#]+)#(\d+)$/);
				if (explicit) {
					nwo = explicit[1];
					num = explicit[2];
				} else if (/^\d+$/.test(arg)) {
					nwo = await resolveRepoNwo(ctx.cwd);
					if (!nwo) {
						ctx.ui.notify("/tcc:watch pr: not in a github repo (cd into one, or use `owner/repo#num`)", "error");
						return;
					}
					num = arg;
				} else {
					ctx.ui.notify(`/tcc:watch pr: don't understand '${arg}'`, "error");
					return;
				}
				const id = `pr-${num}`;
				if (watches.has(id)) {
					ctx.ui.notify(`/tcc:watch pr: already watching ${id} (stop it first to refresh)`, "error");
					return;
				}
				addWatch({
					id,
					kind: "pr",
					target: `${nwo}#${num}`,
					queryArgs: ["pr", "view", num, "--repo", nwo, "--json", "state,mergeable,reviewDecision,statusCheckRollup"],
					intervalMs: DEFAULT_POLL_INTERVAL_MS,
					nextCheckAt: Date.now() + DEFAULT_POLL_INTERVAL_MS,
					state: "active",
					statusLine: "polling…",
					cwd: ctx.cwd,
				});
				ctx.ui.notify(`watching ${nwo}#${num}`, "info");
				return;
			}

			if (sub === "run") {
				const arg = parts[1];
				if (!arg || !/^\d+$/.test(arg)) {
					ctx.ui.notify("/tcc:watch run: usage `/tcc:watch run <run-id>` (numeric id)", "error");
					return;
				}
				const id = `run-${arg}`;
				if (watches.has(id)) {
					ctx.ui.notify(`/tcc:watch run: already watching ${id}`, "error");
					return;
				}
				addWatch({
					id,
					kind: "run",
					target: `run ${arg}`,
					queryArgs: ["run", "view", arg, "--json", "status,conclusion,name"],
					intervalMs: DEFAULT_POLL_INTERVAL_MS,
					nextCheckAt: Date.now() + DEFAULT_POLL_INTERVAL_MS,
					state: "active",
					statusLine: "polling…",
					cwd: ctx.cwd,
				});
				ctx.ui.notify(`watching workflow run ${arg}`, "info");
				return;
			}

			ctx.ui.notify(`/tcc:watch: unknown subcommand '${sub}'. Try: pr <num> | run <id> | list | stop <id>`, "error");
		},
	});
}
