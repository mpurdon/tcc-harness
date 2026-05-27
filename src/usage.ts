import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fmtDollars } from "./util.ts";

interface RunningUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	dollars: number;
	turns: number;
	/** Total wall-clock seconds spent in turns for this model — drives tok/s. */
	seconds: number;
}

const session = new Map<string, RunningUsage>();

// Per-turn start timestamps keyed by turnIndex. Stored at turn_start, consumed
// (and deleted) at turn_end so old entries can't leak if a turn aborts mid-flight.
const turnStarts = new Map<number, number>();

// Most recent turn's rates — used by the status-line widget. Reset on session_start.
let lastTurnOutputTps = 0;
let lastTurnInputTps = 0;

function emptyUsage(): RunningUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, dollars: 0, turns: 0, seconds: 0 };
}

function totalDollars(): number {
	let sum = 0;
	for (const u of session.values()) sum += u.dollars;
	return sum;
}

/** Total $ spent across all models in the current session. Consumed by budgets.ts. */
export function getSessionDollars(): number {
	return totalDollars();
}

const fmt$ = fmtDollars;

function fmtN(n: number): string {
	return n.toLocaleString("en-US");
}

function fmtTps(tps: number): string {
	if (!Number.isFinite(tps) || tps <= 0) return "—";
	if (tps >= 1000) return `${(tps / 1000).toFixed(1)}k/s`;
	if (tps >= 100) return `${tps.toFixed(0)}/s`;
	return `${tps.toFixed(1)}/s`;
}

function shortModelName(id: string): string {
	// inference-profile ARN tail → "...profile/oz6q45fqguej" → "oz6q45fqguej"
	const slash = id.lastIndexOf("/");
	if (slash >= 0 && id.length - slash <= 32) return id.slice(slash + 1);
	return id.length > 24 ? `…${id.slice(-20)}` : id;
}

function renderBreakdown(includeTokenDetails: boolean): string {
	if (session.size === 0) return "No usage recorded this session yet.";
	const lines: string[] = [];
	const sortedModels = [...session.entries()].sort((a, b) => b[1].dollars - a[1].dollars);
	for (const [id, u] of sortedModels) {
		const name = shortModelName(id);
		if (includeTokenDetails) {
			const outTps = u.seconds > 0 ? u.output / u.seconds : 0;
			const inTps = u.seconds > 0 ? (u.input + u.cacheRead + u.cacheWrite) / u.seconds : 0;
			lines.push(
				`${name.padEnd(20)}  ${fmt$(u.dollars).padStart(8)}  · ${u.turns} turn${u.turns === 1 ? "" : "s"}` +
					`\n  in ${fmtN(u.input)}  out ${fmtN(u.output)}  cacheR ${fmtN(u.cacheRead)}  cacheW ${fmtN(u.cacheWrite)}` +
					`\n  ${u.seconds.toFixed(1)}s wall  ·  ${fmtTps(outTps)} out  ·  ${fmtTps(inTps)} in (incl. cache)`,
			);
		} else {
			lines.push(`${name.padEnd(20)}  ${fmt$(u.dollars).padStart(8)}  · ${u.turns} turn${u.turns === 1 ? "" : "s"}`);
		}
	}
	lines.push("─".repeat(40));
	lines.push(`${"total".padEnd(20)}  ${fmt$(totalDollars()).padStart(8)}`);
	return lines.join("\n");
}

let lastCostStatus = "";
function updateCostStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const formatted = fmtDollars(totalDollars());
	if (formatted === lastCostStatus) return;
	lastCostStatus = formatted;
	ctx.ui.setStatus("tcc.cost", formatted);
}

let lastTpsStatus = "";
function updateTpsStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	// "↓ 87/s  ↑ 1.2k/s" — output rate first (the streaming bottleneck users feel).
	const formatted = lastTurnOutputTps > 0 ? `↓ ${fmtTps(lastTurnOutputTps)}  ↑ ${fmtTps(lastTurnInputTps)}` : "";
	if (formatted === lastTpsStatus) return;
	lastTpsStatus = formatted;
	ctx.ui.setStatus("tcc.tps", formatted || undefined);
}

export default function usageExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		session.clear();
		turnStarts.clear();
		lastCostStatus = "";
		lastTpsStatus = "";
		lastTurnOutputTps = 0;
		lastTurnInputTps = 0;
		if (ctx.hasUI) {
			const awsProfile = process.env.AWS_PROFILE;
			if (awsProfile) ctx.ui.setStatus("tcc.aws", `aws:${awsProfile}`);
			updateCostStatus(ctx);
		}
	});

	pi.on("turn_start", (event) => {
		// event.timestamp is in ms (matches Date.now()).
		turnStarts.set(event.turnIndex, event.timestamp);
	});

	pi.on("turn_end", (event, ctx) => {
		const model = ctx.model;
		const message = event.message as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } } | undefined;
		const usage = message?.usage;
		if (!model || !usage) return;
		const startedAt = turnStarts.get(event.turnIndex);
		turnStarts.delete(event.turnIndex);
		const seconds = startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;
		const slot = session.get(model.id) ?? emptyUsage();
		slot.input += usage.input;
		slot.output += usage.output;
		slot.cacheRead += usage.cacheRead;
		slot.cacheWrite += usage.cacheWrite;
		slot.dollars += usage.cost?.total ?? 0;
		slot.turns += 1;
		slot.seconds += seconds;
		session.set(model.id, slot);
		// Per-turn rates feed the status widget. Guard against zero-duration turns
		// (cached responses can come back faster than the ms-resolution clock).
		if (seconds > 0.05) {
			lastTurnOutputTps = usage.output / seconds;
			lastTurnInputTps = (usage.input + usage.cacheRead + usage.cacheWrite) / seconds;
		}
		updateCostStatus(ctx);
		updateTpsStatus(ctx);
	});

	pi.registerCommand("tcc:cost", {
		description: "Show session cost in $ broken down by model.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(renderBreakdown(false), "info");
		},
	});

	pi.registerCommand("tcc:usage", {
		description: "Show session token usage in detail (input, output, cache).",
		handler: async (_args, ctx) => {
			ctx.ui.notify(renderBreakdown(true), "info");
		},
	});
}
