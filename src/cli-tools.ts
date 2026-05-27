import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ToolPref {
	preferred: string;
	replaces: string;
	purpose: string;
}

const PREFS: ToolPref[] = [
	{ preferred: "rg", replaces: "grep", purpose: "search file contents" },
	{ preferred: "fd", replaces: "find", purpose: "find files by name" },
	{ preferred: "lsd", replaces: "ls", purpose: "list directory" },
	{ preferred: "bat", replaces: "cat", purpose: "view file contents" },
	{ preferred: "eza", replaces: "ls", purpose: "list directory (alt)" },
	{ preferred: "sd", replaces: "sed", purpose: "stream edit" },
	{ preferred: "dust", replaces: "du", purpose: "disk usage" },
	{ preferred: "jq", replaces: "(none)", purpose: "JSON queries" },
	{ preferred: "gh", replaces: "(none)", purpose: "GitHub API" },
];

const whichCache = new Map<string, string | undefined>();

function which(cmd: string): string | undefined {
	if (whichCache.has(cmd)) return whichCache.get(cmd);
	const path = process.env.PATH ?? "";
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, cmd);
		try {
			accessSync(candidate, constants.X_OK);
			whichCache.set(cmd, candidate);
			return candidate;
		} catch {
			// try next dir
		}
	}
	whichCache.set(cmd, undefined);
	return undefined;
}

function detectAvailable(): ToolPref[] {
	return PREFS.filter((p) => which(p.preferred));
}

function buildShellGuidance(available: ToolPref[]): string {
	if (available.length === 0) return "";
	const seenReplaces = new Map<string, string>();
	for (const p of available) {
		if (p.replaces !== "(none)" && !seenReplaces.has(p.replaces)) {
			seenReplaces.set(p.replaces, p.preferred);
		}
	}
	const lines = ["## Shell conventions on this machine", ""];
	if (seenReplaces.size > 0) {
		lines.push("Prefer the user-installed modern variants when shelling out via `bash`:");
		for (const [old, neu] of seenReplaces) {
			lines.push(`- \`${neu}\` instead of \`${old}\``);
		}
		lines.push("");
	}
	const extras = available.filter((p) => p.replaces === "(none)").map((p) => p.preferred);
	if (extras.length > 0) {
		lines.push(`Other available helpers: \`${extras.join("`, `")}\`.`);
		lines.push("");
	}
	lines.push("Aim for minimal, machine-readable output:");
	lines.push("- `rg -l <pattern>` when you only need matching file paths.");
	lines.push("- `rg -n <pattern>` (line numbers, no color) when you need locations.");
	lines.push("- `fd -t f -t d` to filter by type; default already respects `.gitignore`.");
	lines.push("- Plain `lsd` (no `-l`/`-a` unless you need them); `lsd --tree -d 2` for shallow trees.");
	lines.push("- Avoid color/pretty flags (`--color`, `-l` on `ls`, `-h` size hints) — they bloat output.");
	lines.push("- Pipe through `| head -N` or `| wc -l` rather than dumping huge listings.");
	return lines.join("\n");
}

interface RunOptions {
	bin: string;
	args: string[];
	ctx: ExtensionContext;
	signal: AbortSignal | undefined;
	limit: number;
	emptyText: string;
	noMatchExit?: number;
	truncatedNoun?: string;
}

function runCli(opts: RunOptions) {
	const text = (t: string) => ({ type: "text" as const, text: t });
	const r = spawnSync(opts.bin, opts.args, { cwd: opts.ctx.cwd, encoding: "utf8", signal: opts.signal, maxBuffer: 10 * 1024 * 1024 });
	if (r.error) return { content: [text(`${opts.bin} failed to spawn: ${r.error.message}`)], details: undefined, isError: true };
	if (opts.noMatchExit !== undefined && r.status === opts.noMatchExit) {
		return { content: [text(opts.emptyText)], details: undefined };
	}
	if (r.status !== 0) {
		return { content: [text(`${opts.bin} exit ${r.status}: ${(r.stderr ?? "").trim()}`)], details: undefined, isError: true };
	}
	const lines = (r.stdout ?? "").split("\n").filter(Boolean);
	if (lines.length === 0) return { content: [text(opts.emptyText)], details: undefined };
	const shown = lines.slice(0, opts.limit).join("\n");
	const tail = lines.length > opts.limit ? `\n... ${lines.length - opts.limit} more ${opts.truncatedNoun ?? "lines"} truncated` : "";
	return { content: [text(shown + tail)], details: undefined };
}

function registerSearchText(pi: ExtensionAPI, rg: string): void {
	pi.registerTool({
		name: "search_text",
		label: "ripgrep",
		description:
			"Fast recursive content search via ripgrep. Respects .gitignore. Returns matches as 'path:line:text' (or just paths when filesOnly=true). Prefer this over running `rg`/`grep` through bash.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regex pattern (Rust regex syntax)." }),
			path: Type.Optional(Type.String({ description: "Directory or file to search. Defaults to cwd." })),
			filesOnly: Type.Optional(Type.Boolean({ description: "Return only matching file paths." })),
			caseSensitive: Type.Optional(Type.Boolean({ description: "Force case-sensitive search (default: smart-case)." })),
			maxResults: Type.Optional(Type.Number({ description: "Truncate after this many lines (default 200)." })),
			glob: Type.Optional(Type.String({ description: "Restrict to paths matching this glob, e.g. '*.ts'." })),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const args = params.filesOnly ? ["--files-with-matches"] : ["--no-heading", "--no-color", "--line-number"];
			args.push(params.caseSensitive ? "--case-sensitive" : "--smart-case");
			if (params.glob) args.push("--glob", params.glob);
			args.push("--", params.pattern, params.path ?? ".");
			return runCli({ bin: rg, args, ctx, signal, limit: params.maxResults ?? 200, emptyText: "(no matches)", noMatchExit: 1 });
		},
	});
}

function registerFindFiles(pi: ExtensionAPI, fd: string): void {
	pi.registerTool({
		name: "find_files",
		label: "fd",
		description: "Find files/dirs by name via fd. Respects .gitignore by default. Prefer this over running `find`/`fd` through bash.",
		parameters: Type.Object({
			pattern: Type.Optional(Type.String({ description: "Regex pattern to match against file names (default: list everything)." })),
			path: Type.Optional(Type.String({ description: "Search root. Defaults to cwd." })),
			type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("symlink")])),
			extension: Type.Optional(Type.String({ description: "File extension without the dot, e.g. 'ts'." })),
			includeHidden: Type.Optional(Type.Boolean({ description: "Search inside hidden directories." })),
			maxResults: Type.Optional(Type.Number({ description: "Truncate after this many results (default 200)." })),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const args: string[] = ["--color=never"];
			if (params.type) args.push("--type", params.type === "directory" ? "d" : params.type === "symlink" ? "l" : "f");
			if (params.extension) args.push("--extension", params.extension);
			if (params.includeHidden) args.push("--hidden");
			if (params.pattern) args.push(params.pattern);
			if (params.path) args.push(params.path);
			return runCli({ bin: fd, args, ctx, signal, limit: params.maxResults ?? 200, emptyText: "(no matches)", truncatedNoun: "results" });
		},
	});
}

export default function cliToolsExtension(pi: ExtensionAPI): void {
	const available = detectAvailable();
	console.error(`[tcc] cli tools available: ${available.map((p) => p.preferred).join(", ") || "(none)"}`);

	const guidance = buildShellGuidance(available);
	if (guidance) {
		// Cache-stable: `guidance` is computed once at extension load (no per-turn
		// changes), so every turn appends the same string. Bedrock prompt caching
		// depends on this — if `guidance` ever becomes dynamic (e.g. embeds a
		// timestamp), the system-prompt cache hit collapses and we silently start
		// paying full input price every turn.
		pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${guidance}` }));
	}

	const rg = which("rg");
	if (rg) registerSearchText(pi, rg);
	const fd = which("fd");
	if (fd) registerFindFiles(pi, fd);

	// Pi ships built-in `grep` and `find` tools that mirror the system commands.
	// When our ripgrep/fd-backed alternatives are available they're strictly
	// better (gitignore-aware, smart-case, faster), but the LLM keeps reaching
	// for the built-ins by name — especially after compaction, when the
	// transcript history that demonstrated `search_text` use has been summarized
	// away. Pruning them from the active tool set removes them from the system
	// prompt entirely, so the only way to do content search / file find is via
	// our tools or bash (which the shell guidance already steers).
	//
	// `ls` is intentionally left in place: there's no replacement tool and it's
	// useful as a low-noise primitive for orientation.
	//
	// Opt out with TCC_KEEP_BUILTIN_SEARCH_TOOLS=1 if pi's grep/find are needed
	// (e.g. on a host without rg/fd, or to A/B compare results).
	const keepBuiltins = process.env.TCC_KEEP_BUILTIN_SEARCH_TOOLS === "1";
	if (!keepBuiltins && (rg || fd)) {
		pi.on("session_start", () => {
			const disable = new Set<string>();
			if (rg) disable.add("grep");
			if (fd) disable.add("find");
			const current = pi.getActiveTools();
			const filtered = current.filter((n) => !disable.has(n));
			if (filtered.length !== current.length) {
				pi.setActiveTools(filtered);
				console.error(`[tcc] disabled built-in tools (use search_text/find_files instead): ${[...disable].join(", ")}`);
			}
		});
	}
}
