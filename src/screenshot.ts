import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "./util.ts";

type CaptureMode = "full" | "selection" | "window";

const MODE_FLAGS: Record<CaptureMode, string[]> = {
	full: [],
	selection: ["-i"],
	window: ["-w"],
};

export default function screenshotExtension(pi: ExtensionAPI): void {
	if (process.platform !== "darwin") return;

	pi.registerTool({
		name: "screenshot",
		label: "screenshot",
		description:
			"Capture a screenshot via macOS `screencapture` and return it as image input. " +
			"Modes: 'full' (whole screen, default), 'selection' (interactive rectangle — user drags), 'window' (interactive — user clicks a window). " +
			"Only available on macOS.",
		parameters: Type.Object({
			mode: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("selection"), Type.Literal("window")])),
			delaySeconds: Type.Optional(Type.Number({ description: "Wait N seconds before capturing (default 0). Useful for setting up the screen." })),
		}),
		async execute(_id, params, signal) {
			const mode: CaptureMode = params.mode ?? "full";
			const dir = join(tmpdir(), "tcc-screenshots");
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `${Date.now()}.png`);
			const delay = params.delaySeconds && params.delaySeconds > 0 ? ["-T", String(Math.floor(params.delaySeconds))] : [];
			const args = ["-t", "png", "-x", ...MODE_FLAGS[mode], ...delay, file];

			try {
				const r = await runProcess({ cmd: "screencapture", args, signal, timeoutMs: 60_000 });
				if (r.reason !== "exit" || (r.exitCode !== 0 && r.exitCode !== null)) {
					return { content: [{ type: "text", text: `screencapture failed (${r.reason}, exit ${r.exitCode}): ${r.stderr || "(no stderr)"}` }], details: undefined, isError: true };
				}
				let buf: Buffer;
				try {
					buf = readFileSync(file);
				} catch (err) {
					return { content: [{ type: "text", text: `failed to read capture file: ${(err as Error).message}` }], details: undefined, isError: true };
				}
				return {
					content: [
						{ type: "text", text: `[screenshot · ${mode} · ${(buf.length / 1024).toFixed(0)}KB]` },
						{ type: "image", mimeType: "image/png", data: buf.toString("base64") },
					],
					details: undefined,
				};
			} finally {
				try {
					unlinkSync(file);
				} catch {
					// best-effort; missing file is fine
				}
			}
		},
	});
}
