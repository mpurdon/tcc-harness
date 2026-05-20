import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fmtDollars } from "./util.ts";

interface RunningUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	dollars: number;
	turns: number;
}

const session = new Map<string, RunningUsage>();

function emptyUsage(): RunningUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, dollars: 0, turns: 0 };
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
			lines.push(
				`${name.padEnd(20)}  ${fmt$(u.dollars).padStart(8)}  · ${u.turns} turn${u.turns === 1 ? "" : "s"}` +
					`\n  in ${fmtN(u.input)}  out ${fmtN(u.output)}  cacheR ${fmtN(u.cacheRead)}  cacheW ${fmtN(u.cacheWrite)}`,
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

export default function usageExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		session.clear();
		lastCostStatus = "";
		if (ctx.hasUI) {
			const awsProfile = process.env.AWS_PROFILE;
			if (awsProfile) ctx.ui.setStatus("tcc.aws", `aws:${awsProfile}`);
			updateCostStatus(ctx);
		}
	});

	pi.on("turn_end", (event, ctx) => {
		const model = ctx.model;
		const message = event.message as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } } | undefined;
		const usage = message?.usage;
		if (!model || !usage) return;
		const slot = session.get(model.id) ?? emptyUsage();
		slot.input += usage.input;
		slot.output += usage.output;
		slot.cacheRead += usage.cacheRead;
		slot.cacheWrite += usage.cacheWrite;
		slot.dollars += usage.cost?.total ?? 0;
		slot.turns += 1;
		session.set(model.id, slot);
		updateCostStatus(ctx);
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
