import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "./util.ts";

function sharesDir(): string {
	const dir = join(homedir(), ".tcc", "shares");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function timestampSlug(): string {
	const d = new Date();
	const pad = (n: number) => `${n}`.padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export default function shareExtension(pi: ExtensionAPI): void {
	// Pi's built-in /share AND /export both have different semantics; ours wraps `pi --export` to HTML at ~/.tcc/shares/.
	pi.registerCommand("tcc:snapshot", {
		description: "Snapshot the current session to HTML at ~/.tcc/shares/<timestamp>.html and open it.",
		handler: async (args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("/tcc:snapshot: no session file (running --no-session?)", "error");
				return;
			}
			const slug = args.trim().split(/\s+/)[0] || timestampSlug();
			const outPath = join(sharesDir(), `${slug}.html`);

			ctx.ui.setStatus("tcc.snapshot", "exporting…");
			try {
				const exp = await runProcess({ cmd: "pi", args: ["--export", sessionFile, outPath], timeoutMs: 60_000 });
				if (exp.reason !== "exit" || (exp.exitCode !== 0 && exp.exitCode !== null)) {
					ctx.ui.notify(`/tcc:snapshot: pi --export failed (${exp.reason}, exit ${exp.exitCode}):\n${exp.stderr || "(no stderr)"}`, "error");
					return;
				}
				const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
				await runProcess({ cmd: openCmd, args: [outPath], timeoutMs: 5_000 });
				ctx.ui.notify(`snapshot saved: ${basename(outPath)} → ${outPath}`, "info");
			} finally {
				ctx.ui.setStatus("tcc.snapshot", undefined);
			}
		},
	});
}
