import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSessionDollars } from "./usage.ts";
import { fmtDollars } from "./util.ts";

function fmtDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export default function exitSummaryExtension(pi: ExtensionAPI): void {
	let sessionStartMs = 0;
	let turns = 0;

	pi.on("session_start", () => {
		sessionStartMs = Date.now();
		turns = 0;
	});

	pi.on("turn_end", () => {
		turns += 1;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (sessionStartMs === 0 || turns === 0) return;
		const dollars = getSessionDollars();
		const duration = fmtDuration(Date.now() - sessionStartMs);
		const cost = dollars > 0 ? ` · ${fmtDollars(dollars)}` : "";
		const line = `  session: ${turns} turn${turns === 1 ? "" : "s"} · ${duration}${cost}`;
		if (ctx.hasUI) {
			ctx.ui.notify(line, "info");
		} else {
			console.log(line);
		}
	});
}
