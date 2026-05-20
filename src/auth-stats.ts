import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "./util.ts";

export default function authStatsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:auth", {
		description: "Show AWS SSO auth history + stats (login frequency, session lifetimes, distribution by day of week).",
		handler: async (_args, ctx) => {
			const home = process.env.TCC_HOME;
			if (!home) {
				ctx.ui.notify("/tcc:auth: TCC_HOME not set", "error");
				return;
			}
			const r = await runProcess({ cmd: "node", args: [join(home, "scripts/auth-stats.mjs")], timeoutMs: 10_000 });
			if (r.reason !== "exit" || (r.exitCode !== 0 && r.exitCode !== null)) {
				ctx.ui.notify(`/tcc:auth: failed (${r.reason}, exit ${r.exitCode}):\n${r.stderr || "(no stderr)"}`, "error");
				return;
			}
			ctx.ui.notify(r.stdout, "info");
		},
	});
}
