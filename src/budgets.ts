import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { userConfigDir } from "./config.ts";
import { getSessionDollars } from "./usage.ts";
import { fmtDollars, readJson, writeJsonAtomic } from "./util.ts";

interface BudgetsConfig {
	session?: number;
	daily?: number;
	mode?: "warn" | "pause";
}

interface TccConfig {
	budgets?: BudgetsConfig;
}

interface DailyFile {
	totalDollars: number;
	turns: number;
}

interface ResolvedBudgets {
	session: number; // 0 = uncapped
	daily: number; // 0 = uncapped
	mode: "warn" | "pause";
}

const WARN_THRESHOLDS = [0.8, 0.9, 0.95] as const;

function clampCap(v: unknown, label: string): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
		if (v !== undefined) console.error(`[tcc budgets] '${label}' must be a non-negative number; got ${JSON.stringify(v)} — treating as uncapped`);
		return 0;
	}
	return v;
}

function loadBudgets(): ResolvedBudgets {
	const cfg = readJson<TccConfig>(join(userConfigDir(), "config.json"), "budgets");
	const b = cfg?.budgets ?? {};
	return {
		session: clampCap(b.session, "budgets.session"),
		daily: clampCap(b.daily, "budgets.daily"),
		mode: b.mode === "warn" ? "warn" : "pause",
	};
}

function todayKey(): string {
	return new Date().toISOString().slice(0, 10);
}

function dailyDir(): string {
	return join(userConfigDir(), "daily");
}

function dailyPath(key: string): string {
	return join(dailyDir(), `${key}.json`);
}

function sanitizeDaily(parsed: DailyFile | undefined): DailyFile {
	const total = parsed?.totalDollars;
	const turns = parsed?.turns;
	return {
		totalDollars: typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : 0,
		turns: typeof turns === "number" && Number.isFinite(turns) && turns >= 0 ? Math.floor(turns) : 0,
	};
}

function readDaily(key: string): DailyFile {
	return sanitizeDaily(readJson<DailyFile>(dailyPath(key), "budgets"));
}

let dailyDirEnsured = false;
function writeDaily(key: string, data: DailyFile): void {
	if (!dailyDirEnsured) {
		mkdirSync(dailyDir(), { recursive: true });
		dailyDirEnsured = true;
	}
	writeJsonAtomic(dailyPath(key), data);
}

interface ScopeView {
	name: "session" | "daily";
	used: number;
	cap: number;
	warned: Set<number>;
}

export default function budgetsExtension(pi: ExtensionAPI): void {
	const budgets = loadBudgets();
	let dailyKey = todayKey();
	let dailyDollars = readDaily(dailyKey).totalDollars;
	let dailyTurns = readDaily(dailyKey).turns;
	const warnedSession = new Set<number>();
	const warnedDaily = new Set<number>();
	let overrideActive = false;
	let blockedThisSession = false;

	const scopes = (): ScopeView[] => [
		{ name: "session", used: getSessionDollars(), cap: budgets.session, warned: warnedSession },
		{ name: "daily", used: dailyDollars, cap: budgets.daily, warned: warnedDaily },
	];

	const isBlocked = (): { kind: "session" | "daily"; over: number } | null => {
		if (budgets.mode !== "pause" || overrideActive) return null;
		for (const s of scopes()) {
			if (s.cap > 0 && s.used >= s.cap) return { kind: s.name, over: s.used - s.cap };
		}
		return null;
	};

	const notify = (ctx: ExtensionContext, level: "info" | "warning" | "error", msg: string) => {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
		else console.error(`[tcc budget] ${msg}`);
	};

	const checkWarnings = (ctx: ExtensionContext) => {
		for (const s of scopes()) {
			if (s.cap <= 0) continue;
			for (const t of WARN_THRESHOLDS) {
				if (s.used / s.cap >= t && !s.warned.has(t)) {
					s.warned.add(t);
					notify(ctx, "warning", `${s.name} cost ${fmtDollars(s.used)} / ${fmtDollars(s.cap)} (${(t * 100).toFixed(0)}%)`);
				}
			}
		}
	};

	pi.on("session_start", () => {
		dailyKey = todayKey();
		const daily = readDaily(dailyKey);
		dailyDollars = daily.totalDollars;
		dailyTurns = daily.turns;
		warnedSession.clear();
		warnedDaily.clear();
		overrideActive = false;
		blockedThisSession = false;
	});

	pi.on("turn_end", (event, ctx) => {
		const usage = (event.message as { usage?: { cost?: { total: number } } } | undefined)?.usage;
		const turnCost = usage?.cost?.total ?? 0;
		if (turnCost === 0) return;

		// Detect midnight rollover — flush the current day before starting tomorrow.
		const nowKey = todayKey();
		if (nowKey !== dailyKey) {
			dailyKey = nowKey;
			const fresh = readDaily(nowKey);
			dailyDollars = fresh.totalDollars;
			dailyTurns = fresh.turns;
			warnedDaily.clear();
		}

		dailyDollars += turnCost;
		dailyTurns += 1;
		writeDaily(dailyKey, { totalDollars: dailyDollars, turns: dailyTurns });
		checkWarnings(ctx);

		const blocker = isBlocked();
		if (blocker && !blockedThisSession) {
			blockedThisSession = true;
			notify(ctx, "error", `${blocker.kind} budget exceeded by ${fmtDollars(blocker.over)}. Next user input will be paused. Type '/tcc:budget override' to allow this session to continue.`);
		}
	});

	pi.on("input", async (_event, ctx) => {
		const blocker = isBlocked();
		if (!blocker) return { action: "continue" };
		const used = blocker.kind === "session" ? getSessionDollars() : dailyDollars;
		notify(ctx, "error", `tcc paused: ${blocker.kind} budget exceeded (${fmtDollars(used)}). Use '/tcc:budget override' to continue this session, or '/tcc:budget' for status.`);
		return { action: "handled" };
	});

	pi.registerCommand("tcc:budget", {
		description: "Show cost-budget status. '/tcc:budget override' allows this session to exceed the hard cap; '/tcc:budget reset session' zeroes the session counter (the daily counter is persistent and not affected).",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "override") {
				overrideActive = true;
				blockedThisSession = false;
				notify(ctx, "warning", "budget override active for the rest of this session");
				return;
			}
			if (parts[0] === "reset" && parts[1] === "session") {
				warnedSession.clear();
				blockedThisSession = false;
				notify(ctx, "info", "session warning state reset (note: per-model totals in /tcc:cost are managed by usage.ts and persist)");
				return;
			}
			const lines: string[] = [`mode: ${budgets.mode}${overrideActive ? " (overridden)" : ""}`];
			for (const s of scopes()) {
				if (s.cap > 0) {
					lines.push(`${s.name.padEnd(8)} ${fmtDollars(s.used)} / ${fmtDollars(s.cap)}  (${((s.used / s.cap) * 100).toFixed(0)}%)`);
				} else {
					lines.push(`${s.name.padEnd(8)} ${fmtDollars(s.used)}  (no cap set)`);
				}
			}
			lines.push("");
			lines.push("Set caps in ~/.tcc/config.json:  { \"budgets\": { \"session\": 5.00, \"daily\": 25.00, \"mode\": \"pause\" } }");
			notify(ctx, "info", lines.join("\n"));
		},
	});
}
