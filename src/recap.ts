import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { resolveModel, runPiPrint } from "./research.ts";
import { runProcess } from "./util.ts";

// Rolling "where are we" session recap, rendered as a dim block above the prompt
// (setWidget aboveEditor). Matches Claude Code's recap feature:
//   - Generates in the background and appears ready when you return
//   - Triggers: ≥3 min idle since last turn (CC uses terminal-unfocused; we use idle time,
//     the closest analog in a terminal harness) + on session resume + on demand (/tcc:recap)
//   - Requires ≥3 turns before the first generation (avoids recap on a fresh session)
//   - Never runs twice in a row without a new turn in between
//   - On by default; TCC_RECAP=0 or recap.enabled=false disables

const WIDGET_KEY = "tcc.recap";
const IDLE_TRIGGER_MS = 3 * 60 * 1000; // 3 minutes, matching CC
const GEN_TIMEOUT_MS = 30_000;
const MIN_TURNS = 3;
const MAX_PROMPTS = 12;
const MAX_NOTABLE = 12;

const RECAP_SYSTEM = [
	"You write a one-line session recap shown in a developer's terminal above the prompt.",
	"Given recent git history and a log of what was asked and done:",
	"Write exactly 1 sentence (2-3 clauses, no line breaks): what was accomplished, then a 'Next:' clause naming the single most likely next step.",
	"Be concrete — name file paths, versions, feature names, and counts.",
	"Output only the sentence. No preamble, no markdown, no quotes.",
	"60 words maximum.",
].join(" ");

function config(): { enabled: boolean; model: string | undefined } {
	const c = loadConfig().recap;
	const enabled = process.env.TCC_RECAP !== "0" && c?.enabled !== false;
	return { enabled, model: c?.model };
}

interface RecapState {
	ctx: ExtensionContext | undefined;
	prompts: string[];
	notable: string[];
	toolTally: Map<string, number>;
	turnCount: number;
	lastTurnAt: number;
	lastRecapAt: number;
	generating: boolean;
	shownSinceLastTurn: boolean;
	current: string | undefined;
	idleTimer: NodeJS.Timeout | undefined;
}

const NOTABLE_RE = /\b(git\s+(commit|push|tag|merge|rebase|revert)|npm\s+(test|run|publish)|pnpm\s|yarn\s|make\s|terraform\s|kubectl\s|docker\s|gh\s+(pr|release))/i;

async function gitContext(cwd: string): Promise<string> {
	const run = async (args: string[]): Promise<string> => {
		const r = await runProcess({ cmd: "git", args, cwd, timeoutMs: 4_000 });
		return r.reason === "exit" && r.exitCode === 0 ? (r.stdout ?? "").trim() : "";
	};
	const [log, status] = await Promise.all([
		run(["log", "--oneline", "-10"]),
		run(["status", "--short"]),
	]);
	return [
		`Recent commits:\n${log || "(none)"}`,
		`Uncommitted:\n${status || "(clean)"}`,
	].join("\n\n");
}

function activityBlock(state: RecapState): string {
	const tally = [...state.toolTally.entries()].map(([t, n]) => `${t}×${n}`).join(", ") || "(none)";
	const prompts = state.prompts.length ? state.prompts.map((p) => `- ${p}`).join("\n") : "(none)";
	const notable = state.notable.length ? state.notable.map((c) => `- ${c}`).join("\n") : "(none)";
	return `Recent user requests (${state.turnCount} turns total):\n${prompts}\n\nTool activity: ${tally}\n\nNotable commands:\n${notable}`;
}

function wordWrap(text: string, width: number): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let line = "";
	for (const w of words) {
		if (line.length + w.length + 1 > width) {
			if (line) lines.push(line);
			line = w;
		} else {
			line = line ? `${line} ${w}` : w;
		}
	}
	if (line) lines.push(line);
	return lines;
}

// Visible (non-ANSI) prefix: "  ※ recap  " = 11 chars
const PREFIX_INDENT = "  ";
const PREFIX_LABEL = "※ recap";
const PREFIX_GAP = "  ";
const PREFIX_VISIBLE_LEN = PREFIX_INDENT.length + PREFIX_LABEL.length + PREFIX_GAP.length;
const CONT_PAD = " ".repeat(PREFIX_VISIBLE_LEN);

function render(state: RecapState): void {
	const ctx = state.ctx;
	if (!ctx?.hasUI) return;
	if (!state.current) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	const text = state.current;
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			render(width: number): string[] {
				const bodyWidth = Math.max(20, width - PREFIX_VISIBLE_LEN);
				const coloredPrefix =
					PREFIX_INDENT +
					theme.fg("accent", "※") +
					" " +
					theme.fg("muted", "recap") +
					PREFIX_GAP;
				const bodyLines = wordWrap(text, bodyWidth);
				return bodyLines.map((l, i) =>
					i === 0
						? `${coloredPrefix}${theme.fg("muted", l)}`
						: `${CONT_PAD}${theme.fg("muted", l)}`,
				);
			},
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);
}

async function regenerate(state: RecapState): Promise<void> {
	const ctx = state.ctx;
	if (!ctx?.hasUI || state.generating) return;
	if (state.turnCount < MIN_TURNS) return;
	if (state.shownSinceLastTurn) return; // never twice in a row without a new turn
	const { model: modelPref } = config();
	const model = resolveModel(modelPref ?? "haiku");
	if (!model) return;
	state.generating = true;
	try {
		const task = `${await gitContext(ctx.cwd)}\n\n${activityBlock(state)}`;
		const text = await runPiPrint({ model, system: RECAP_SYSTEM, task, timeoutMs: GEN_TIMEOUT_MS });
		const cleaned = text.replace(/\s+/g, " ").trim();
		if (cleaned) {
			state.current = cleaned;
			state.lastRecapAt = Date.now();
			state.shownSinceLastTurn = true;
			render(state);
		}
	} catch {
		// A recap failure must never disrupt the session.
	} finally {
		state.generating = false;
	}
}

function armIdleTimer(state: RecapState): void {
	if (state.idleTimer) clearTimeout(state.idleTimer);
	state.idleTimer = setTimeout(() => {
		state.idleTimer = undefined;
		void regenerate(state);
	}, IDLE_TRIGGER_MS);
	state.idleTimer.unref?.();
}

export default function recapExtension(pi: ExtensionAPI): void {
	if (!config().enabled) return;

	const state: RecapState = {
		ctx: undefined,
		prompts: [],
		notable: [],
		toolTally: new Map(),
		turnCount: 0,
		lastTurnAt: 0,
		lastRecapAt: 0,
		generating: false,
		shownSinceLastTurn: false,
		current: undefined,
		idleTimer: undefined,
	};

	pi.on("session_start", (event, ctx) => {
		state.ctx = ctx;
		render(state); // restore existing widget into the new session
		// Resume/fork = "coming back" — same trigger CC uses for unfocused terminal.
		if (event.reason === "resume" || event.reason === "fork") {
			void regenerate(state);
		}
	});

	pi.on("input", (event, ctx) => {
		state.ctx = ctx;
		if (event.source === "extension") return;
		state.shownSinceLastTurn = false; // new turn: allowed to show recap again
		armIdleTimer(state); // restart the idle clock on each new user message
		const text = event.text.trim();
		if (!text) return;
		state.prompts.push(text.length > 160 ? `${text.slice(0, 160)}…` : text);
		if (state.prompts.length > MAX_PROMPTS) state.prompts.shift();
	});

	pi.on("tool_call", (event, ctx) => {
		state.ctx = ctx;
		state.toolTally.set(event.toolName, (state.toolTally.get(event.toolName) ?? 0) + 1);
		if (isToolCallEventType("bash", event)) {
			const cmd = event.input.command;
			if (NOTABLE_RE.test(cmd)) {
				state.notable.push(cmd.length > 100 ? `${cmd.slice(0, 100)}…` : cmd);
				if (state.notable.length > MAX_NOTABLE) state.notable.shift();
			}
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		state.ctx = ctx;
		state.turnCount += 1;
		state.lastTurnAt = Date.now();
		// Arm the idle timer: if no new input arrives in 3 min, generate in background.
		armIdleTimer(state);
	});

	pi.on("session_shutdown", () => {
		if (state.idleTimer) clearTimeout(state.idleTimer);
		state.ctx?.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerCommand("tcc:recap", {
		description: "Regenerate the session recap immediately (shown above the prompt — auto-regenerates after ~3 min idle or on session resume).",
		handler: async (_args, ctx) => {
			state.ctx = ctx;
			state.shownSinceLastTurn = false; // on-demand always bypasses the "twice in a row" guard
			ctx.ui.notify("generating recap…", "info");
			await regenerate(state);
		},
	});
}
