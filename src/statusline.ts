import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { getSessionDollars } from "./usage.ts";
import { runProcess } from "./util.ts";

// TCC's footer is composed of keyed segments other extensions set via
// ctx.ui.setStatus (tcc.cost, tcc.tps, tcc.aws, …). This lets the user add one
// of their own from a shell command — Claude Code's statusLine.command analog.
// The command's first stdout line becomes the `tcc.custom` segment.

const STATUS_KEY = "tcc.custom";
const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 2_000;
const RUN_TIMEOUT_MS = 3_000;

function statusCommand(): string | undefined {
	const fromEnv = process.env.TCC_STATUSLINE_CMD?.trim();
	if (fromEnv) return fromEnv;
	const fromCfg = loadConfig().statusLine?.command?.trim();
	return fromCfg || undefined;
}

export default function statuslineExtension(pi: ExtensionAPI): void {
	const command = statusCommand();
	if (!command) return; // nothing configured — stay invisible

	const intervalMs = Math.max(MIN_INTERVAL_MS, loadConfig().statusLine?.intervalMs ?? DEFAULT_INTERVAL_MS);
	let ctxRef: ExtensionContext | undefined;
	let running = false; // skip overlapping runs if a script runs long
	let timer: NodeJS.Timeout | undefined;

	const refresh = async (): Promise<void> => {
		const ctx = ctxRef;
		if (!ctx || !ctx.hasUI || running) return;
		running = true;
		try {
			const res = await runProcess({
				cmd: "/bin/sh",
				args: ["-c", command],
				cwd: ctx.cwd,
				env: {
					...process.env,
					TCC_SL_CWD: ctx.cwd,
					TCC_SL_MODEL: ctx.model?.name ?? "",
					TCC_SL_AWS_PROFILE: process.env.AWS_PROFILE ?? "",
					TCC_SL_DOLLARS: getSessionDollars().toFixed(4),
				},
				timeoutMs: RUN_TIMEOUT_MS,
			});
			const line = (res.stdout || "").split("\n")[0].trim();
			ctx.ui.setStatus(STATUS_KEY, line || undefined);
		} catch {
			// A flaky status-line script must never disrupt the session.
		} finally {
			running = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		void refresh();
		if (timer) clearInterval(timer);
		timer = setInterval(() => void refresh(), intervalMs);
		timer.unref?.(); // don't keep the process alive on the refresh timer
	});

	pi.on("turn_end", (_event, ctx) => {
		ctxRef = ctx;
		void refresh();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
	});
}
