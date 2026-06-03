import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";

function config(): { enabled: boolean; threshold: number } {
	const c = loadConfig().autoCompact;
	const enabled = process.env.TCC_AUTO_COMPACT !== "0" && c?.enabled !== false;
	const raw = Number(process.env.TCC_AUTO_COMPACT_THRESHOLD ?? c?.threshold ?? 88);
	const threshold = Number.isFinite(raw) ? Math.max(50, Math.min(99, raw)) : 88;
	return { enabled, threshold };
}

export default function autoCompactExtension(pi: ExtensionAPI): void {
	let pendingCompact = false;

	pi.on("session_start", () => {
		pendingCompact = false;
	});

	pi.on("session_compact", () => {
		pendingCompact = false;
	});

	pi.on("turn_end", (_event, ctx) => {
		if (pendingCompact) return;
		const { enabled, threshold } = config();
		if (!enabled) return;
		const usage = ctx.getContextUsage();
		if (usage?.percent == null) return;
		if (usage.percent < threshold) return;
		pendingCompact = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`auto-compacting: context at ${Math.round(usage.percent)}% (threshold ${threshold}%)`,
				"info",
			);
		}
		ctx.compact();
	});
}
