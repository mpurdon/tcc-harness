import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { userConfigDir } from "./config.ts";
import { readJson, runProcess } from "./util.ts";

const MT_LOG_FILE = "mt-log.jsonl";

interface ReviewLogEntry {
	ts: string;
	tool: string;
	approve: boolean;
	latencyMs: number;
	reason?: string;
}

function logReview(entry: ReviewLogEntry): void {
	try {
		mkdirSync(userConfigDir(), { recursive: true });
		appendFileSync(join(userConfigDir(), MT_LOG_FILE), `${JSON.stringify(entry)}\n`);
	} catch {
		// best-effort — never break a session over telemetry
	}
}

function readLog(): ReviewLogEntry[] {
	try {
		const raw = readFileSync(join(userConfigDir(), MT_LOG_FILE), "utf8");
		const out: ReviewLogEntry[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as ReviewLogEntry);
			} catch {
				// skip malformed line
			}
		}
		return out;
	} catch {
		return [];
	}
}

type ModelChoice = "same" | "sonnet" | "opus" | "haiku" | string;

interface MeasureTwiceConfig {
	enabled?: boolean;
	/** 'same' uses whatever the main agent is on; 'opus'/'sonnet'/'haiku' map to ARNs;
	 *  any other string is treated as an explicit ARN. */
	model?: ModelChoice;
	/** Tool names to gate. Defaults to the high-impact mutating tools. */
	tools?: string[];
}

interface TccConfig {
	measureTwice?: MeasureTwiceConfig;
}

const DEFAULT_TOOLS = ["write", "edit", "bash", "delegate"];

function loadConfig(): Required<MeasureTwiceConfig> {
	const file = readJson<TccConfig>(join(userConfigDir(), "config.json"), "measure-twice");
	const mt = file?.measureTwice ?? {};
	return {
		enabled: process.env.TCC_MEASURE_TWICE === "1" || mt.enabled === true,
		model: mt.model ?? "same",
		tools: mt.tools && mt.tools.length > 0 ? mt.tools : DEFAULT_TOOLS,
	};
}

function resolveModelArn(choice: ModelChoice, currentArn: string | undefined): string | undefined {
	if (choice === "same") return currentArn;
	if (choice.startsWith("arn:")) return choice;
	const env: Record<string, string | undefined> = {
		sonnet: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
		opus: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
		haiku: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
	};
	return env[choice.toLowerCase()];
}

// Tools that produce new/changed code in the diff — for these we want a complexity
// pass in addition to the safety review. bash gets the safety review only (its
// concerns are side-effects, not source-code complexity).
const CODE_WRITING_TOOLS = new Set(["write", "edit", "delegate"]);

function reviewerPrompt(toolName: string, args: unknown): string {
	const isCodeWriting = CODE_WRITING_TOOLS.has(toolName);
	const complexityCriteria = isCodeWriting
		? [
			"",
			"For code-writing actions (write/edit/delegate), ALSO check the planned code against these complexity & SonarQube-style bars and BLOCK if any are crossed without a clear reason:",
			"- Cyclomatic complexity > 15 for any new/modified function (SonarQube default; count if/else/case/&&/||/?:/catch/for/while branches).",
			"- Cognitive complexity > 15 (SonarQube default; nesting weighted: each level deeper inside a conditional/loop adds its depth).",
			"- Function length > ~50 lines of non-trivial code, OR > 5 parameters (suggest an options object), OR nesting depth > 4.",
			"- Magic numbers/literals: numeric literals beyond 0/1/-1 or duplicated string literals (≥2 occurrences) that should be named constants.",
			"- Security hotspots: hardcoded credentials, SQL/shell built by string concat, eval/Function from untrusted input, weak crypto for security purposes, regex with catastrophic backtracking.",
			"- Type lies: `any`, `as unknown as X`, or `@ts-ignore` without a justifying inline comment.",
			"",
			"When blocking on complexity, name the specific bar crossed (e.g. 'cyclomatic ~14 in processOrder; extract validation block').",
		]
		: [];
	return [
		"You are reviewing a planned coding action an AI agent is about to execute, sanity-check style. The agent has good intent; your job is to catch genuine mistakes before they happen.",
		"",
		`TOOL: ${toolName}`,
		"ARGUMENTS (JSON):",
		"```",
		JSON.stringify(args, null, 2).slice(0, 8_000),
		"```",
		...complexityCriteria,
		"",
		"Reply with exactly one of:",
		"- `APPROVE` — the action is reasonable and you'd let it proceed.",
		"- `BLOCK: <one short sentence>` — the action has a clear problem (wrong file, broken syntax, dangerous side effect, contradicts what a sensible coder would do here, has a much better alternative, OR crosses a complexity/security bar listed above).",
		"",
		"Bar: only block on real issues. When in doubt, APPROVE — you have less context than the main agent and we don't want to be a bottleneck. Do not block on style preferences or 'I would have done it differently.'",
	].join("\n");
}

interface Verdict {
	approve: boolean;
	reason: string;
}

function parseVerdict(stdout: string): Verdict {
	const text = stdout.trim();
	if (/^APPROVE\b/i.test(text)) return { approve: true, reason: "" };
	const blockMatch = text.match(/^BLOCK\s*:?\s*(.+)$/im);
	if (blockMatch) return { approve: false, reason: blockMatch[1].trim().slice(0, 300) };
	// Ambiguous response — fail open but surface the response for debugging.
	console.error(`[tcc measure-twice] ambiguous reviewer response: ${text.slice(0, 200)}`);
	return { approve: true, reason: "" };
}

async function review(event: ToolCallEvent, reviewerArn: string, signal: AbortSignal | undefined): Promise<Verdict> {
	const result = await runProcess({
		cmd: "pi",
		args: [
			"--print",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-themes",
			"--no-tools",
			"--provider",
			"amazon-bedrock",
			"--model",
			reviewerArn,
			reviewerPrompt(event.toolName, event.input),
		],
		signal,
		timeoutMs: 60_000,
	});
	if (result.reason !== "exit" || (result.exitCode !== 0 && result.exitCode !== null)) {
		console.error(`[tcc measure-twice] reviewer ${result.reason}, exit ${result.exitCode} — defaulting to approve`);
		return { approve: true, reason: "" };
	}
	return parseVerdict(result.stdout);
}

interface RuntimeState {
	enabled: boolean;
	model: ModelChoice;
	tools: Set<string>;
}

export default function measureTwiceExtension(pi: ExtensionAPI): void {
	const cfg = loadConfig();
	const state: RuntimeState = { enabled: cfg.enabled, model: cfg.model, tools: new Set(cfg.tools) };

	pi.on("tool_call", async (event, ctx) => {
		if (!state.enabled) return;
		if (!state.tools.has(event.toolName)) return;
		const reviewerArn = resolveModelArn(state.model, ctx.model?.id);
		if (!reviewerArn) {
			console.error(`[tcc measure-twice] could not resolve reviewer model '${state.model}' — skipping`);
			return;
		}
		ctx.ui.setStatus("tcc.mt", `→ ${event.toolName}`);
		const started = Date.now();
		let verdict: Verdict;
		try {
			verdict = await review(event, reviewerArn, ctx.signal);
		} catch (err) {
			ctx.ui.setStatus("tcc.mt", undefined);
			throw err;
		}
		const latencyMs = Date.now() - started;
		logReview({ ts: new Date().toISOString(), tool: event.toolName, approve: verdict.approve, latencyMs, reason: verdict.approve ? undefined : verdict.reason });

		if (!verdict.approve) {
			// Leave the blocked badge visible until the next status change so the user sees it.
			ctx.ui.setStatus("tcc.mt", `✗ blocked: ${verdict.reason.slice(0, 60)}`);
			return { block: true, reason: `[measure-twice] ${verdict.reason}` };
		}
		ctx.ui.setStatus("tcc.mt", `✓ approved (${(latencyMs / 1000).toFixed(1)}s)`);
		setTimeout(() => ctx.ui.setStatus("tcc.mt", undefined), 2_000).unref?.();
	});

	pi.registerCommand("tcc:mt", {
		description: "Measure-twice mode (review each gated tool call with a second model before executing). Usage: /tcc:mt on|off|status|model <name>|tools <list>|log [N]|stats",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = parts[0]?.toLowerCase();
			if (cmd === "on") {
				state.enabled = true;
				ctx.ui.notify(`measure-twice: ON (reviewer=${state.model}, tools=${[...state.tools].join(",")})`, "info");
				return;
			}
			if (cmd === "off") {
				state.enabled = false;
				ctx.ui.notify("measure-twice: OFF", "info");
				return;
			}
			if (cmd === "model") {
				if (!parts[1]) {
					ctx.ui.notify(`measure-twice reviewer: ${state.model}`, "info");
					return;
				}
				state.model = parts[1];
				ctx.ui.notify(`measure-twice reviewer: ${state.model}`, "info");
				return;
			}
			if (cmd === "log") {
				const n = Math.max(1, Math.min(500, Number.parseInt(parts[1] ?? "20", 10) || 20));
				const entries = readLog().slice(-n);
				if (entries.length === 0) {
					ctx.ui.notify(`measure-twice log is empty (${join(userConfigDir(), MT_LOG_FILE)})`, "info");
					return;
				}
				const lines = [`Last ${entries.length} measure-twice reviews:`];
				for (const e of entries) {
					const verdict = e.approve ? "✓" : "✗";
					const reason = e.reason ? ` — ${e.reason}` : "";
					lines.push(`  ${e.ts}  ${verdict} ${e.tool.padEnd(10)} ${`${e.latencyMs}ms`.padStart(7)}${reason}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (cmd === "stats") {
				const entries = readLog();
				if (entries.length === 0) {
					ctx.ui.notify("measure-twice has not reviewed any calls yet", "info");
					return;
				}
				const approved = entries.filter((e) => e.approve).length;
				const blocked = entries.length - approved;
				const totalMs = entries.reduce((s, e) => s + e.latencyMs, 0);
				const meanMs = Math.round(totalMs / entries.length);
				const byTool = new Map<string, number>();
				for (const e of entries) byTool.set(e.tool, (byTool.get(e.tool) ?? 0) + 1);
				const toolBreakdown = [...byTool.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}=${c}`).join(", ");
				ctx.ui.notify(
					[
						`measure-twice stats (all time, from ${entries[0].ts}):`,
						`  total reviews:  ${entries.length}`,
						`  approved:       ${approved} (${((approved / entries.length) * 100).toFixed(1)}%)`,
						`  blocked:        ${blocked} (${((blocked / entries.length) * 100).toFixed(1)}%)`,
						`  mean latency:   ${meanMs}ms`,
						`  total reviewer time: ${(totalMs / 1000).toFixed(1)}s`,
						`  by tool:        ${toolBreakdown}`,
					].join("\n"),
					"info",
				);
				return;
			}
			if (cmd === "tools") {
				if (parts.length < 2) {
					ctx.ui.notify(`measure-twice tools: ${[...state.tools].join(",") || "(none)"}`, "info");
					return;
				}
				state.tools = new Set(parts.slice(1).flatMap((p) => p.split(",")).filter(Boolean));
				ctx.ui.notify(`measure-twice tools: ${[...state.tools].join(",")}`, "info");
				return;
			}
			// status / default
			ctx.ui.notify(
				[
					`measure-twice: ${state.enabled ? "ON" : "OFF"}`,
					`  reviewer model: ${state.model}`,
					`  gated tools:    ${[...state.tools].join(", ") || "(none)"}`,
					"",
					"Persist in ~/.tcc/config.json:  { \"measureTwice\": { \"enabled\": true, \"model\": \"opus\", \"tools\": [\"write\",\"edit\",\"bash\"] } }",
					"Or env: TCC_MEASURE_TWICE=1",
				].join("\n"),
				"info",
			);
		},
	});
}
