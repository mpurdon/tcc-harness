import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "./util.ts";

const MAX_FILE_BYTES = 6_000;
const MAX_TOTAL_BYTES = 32_000;

function truncate(s: string, maxBytes: number): { text: string; truncated: boolean } {
	if (s.length <= maxBytes) return { text: s, truncated: false };
	return { text: `${s.slice(0, maxBytes)}\n… [truncated ${s.length - maxBytes} bytes]`, truncated: true };
}

interface DiffSlice {
	header: string;
	body: string;
}

/** Split a `git diff` payload by `diff --git ...` headers. */
function splitByFile(diff: string): DiffSlice[] {
	if (!diff.trim()) return [];
	const parts = diff.split(/(?=^diff --git )/m);
	return parts.filter(Boolean).map((p) => {
		const newlineIdx = p.indexOf("\n");
		return { header: p.slice(0, newlineIdx >= 0 ? newlineIdx : p.length), body: p };
	});
}

export default function gitToolsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "git_diff_preview",
		label: "git diff (truncated)",
		description:
			"Run `git diff <range>` and return a token-aware preview: a `--stat` summary plus per-file hunks capped at ~6KB each (and ~32KB total). " +
			"Use this over bash + git diff when reviewing changes — avoids dumping 10k+ line diffs into context. " +
			"Default range is the working tree (staged + unstaged); pass an explicit range like 'HEAD~1..HEAD' or 'main..HEAD' for a commit-range diff.",
		parameters: Type.Object({
			range: Type.Optional(Type.String({ description: "Range or commit (e.g. 'HEAD~1..HEAD'). Omit for working-tree diff (staged + unstaged)." })),
			path: Type.Optional(Type.String({ description: "Restrict to a single file or directory." })),
			maxBytesPerFile: Type.Optional(Type.Number({ description: `Cap each file's diff body at this many bytes (default ${MAX_FILE_BYTES}).` })),
			maxTotalBytes: Type.Optional(Type.Number({ description: `Cap total output at this many bytes (default ${MAX_TOTAL_BYTES}).` })),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const perFile = params.maxBytesPerFile ?? MAX_FILE_BYTES;
			const totalMax = params.maxTotalBytes ?? MAX_TOTAL_BYTES;

			const buildArgs = (extra: string[]) => {
				const args = ["-C", ctx.cwd, "diff"];
				if (params.range) args.push(params.range);
				args.push(...extra);
				if (params.path) args.push("--", params.path);
				return args;
			};

			const [statRes, fullRes] = await Promise.all([
				runProcess({ cmd: "git", args: buildArgs(["--stat=120,80"]), signal }),
				runProcess({ cmd: "git", args: buildArgs([]), signal }),
			]);
			if (statRes.reason !== "exit" || (statRes.exitCode !== 0 && statRes.exitCode !== null)) {
				return {
					content: [{ type: "text", text: `git diff --stat failed (${statRes.reason}, exit ${statRes.exitCode}):\n${statRes.stderr || "(no stderr)"}` }],
					details: undefined,
					isError: true,
				};
			}
			if (fullRes.reason !== "exit") {
				return { content: [{ type: "text", text: `git diff failed (${fullRes.reason}):\n${fullRes.stderr || "(no stderr)"}` }], details: undefined, isError: true };
			}
			const stat = statRes.stdout.trim() || "(no changes)";

			const slices = splitByFile(fullRes.stdout);
			let total = stat.length;
			const out: string[] = ["## stat", stat, ""];
			let droppedFiles = 0;
			for (const slice of slices) {
				const { text } = truncate(slice.body, perFile);
				if (total + text.length + 4 > totalMax) {
					droppedFiles += 1;
					continue;
				}
				out.push(text);
				total += text.length + 4;
			}
			if (droppedFiles > 0) out.push(`\n[${droppedFiles} file diff(s) omitted — total output capped at ${totalMax} bytes; rerun with a tighter --path scope or larger maxTotalBytes]`);
			return { content: [{ type: "text", text: out.join("\n") }], details: undefined };
		},
	});
}
