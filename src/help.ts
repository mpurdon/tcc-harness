import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Slash commands registered by tcc extensions — kept in sync with each file's
 *  pi.registerCommand calls so /tcc can show a curated, summarized list. */
const TCC_COMMANDS: { name: string; summary: string; source: string }[] = [
	{ name: "/tcc:auth", summary: "AWS SSO auth history + session-lifetime stats", source: "auth-stats" },
	{ name: "/tcc:budget", summary: "show cost-budget status; /tcc:budget override or reset session", source: "budgets" },
	{ name: "/tcc:checkpoint", summary: "list/show/set a workflow checkpoint", source: "checkpoints" },
	{ name: "/tcc:cost", summary: "show session cost broken down by model", source: "usage" },
	{ name: "/tcc:forget", summary: "delete a memory by name", source: "memory" },
	{ name: "/tcc:sso", summary: "refresh AWS SSO session without leaving tcc (pi's /login is OAuth)", source: "login" },
	{ name: "/tcc:mt", summary: "measure-twice mode — review each gated tool call with a second model", source: "measure-twice" },
	{ name: "/tcc:onboard", summary: "scan this repo, write AGENTS.md, save project memories", source: "onboard" },
	{ name: "/tcc:remember", summary: "save free-text to memory (agent picks slug + type)", source: "memory" },
	{ name: "/tcc:retro", summary: "ask the agent to propose memories worth saving from this session", source: "retro" },
	{ name: "/tcc:snapshot", summary: "snapshot this session to HTML at ~/.tcc/shares/ (pi's /share + /export both differ)", source: "share" },
	{ name: "/tcc:theme", summary: "switch theme live (curated set: tokyo-night, catppuccin-mocha, gruvbox-dark); /tcc:theme save persists", source: "theme" },
	{ name: "/tcc:plugin", summary: "list/enable/disable marketplace plugins — /tcc:plugin disable <name@marketplace>", source: "plugin-admin" },
	{ name: "/tcc:watch", summary: "async background watch of GitHub PRs/workflow runs; widget shows next-check + status; notifies on completion", source: "watch" },
	{ name: "/tcc:since", summary: "re-run a workflow against changes since the last checkpoint", source: "checkpoints" },
	{ name: "/tcc:one-last-pass", summary: "deep scrutiny: correctness reviewer + WA-pillars + reuse/quality/efficiency → aggregate → plan → execute", source: "one-last-pass" },
	{ name: "/tcc", summary: "this reference — tcc-specific commands, tools, env knobs (the only un-prefixed tcc command)", source: "help" },
	{ name: "/tcc:usage", summary: "detailed token usage breakdown by model", source: "usage" },
];

const TCC_TOOLS: { name: string; summary: string }[] = [
	{ name: "checkpoint_get / checkpoint_set", summary: "read/write per-repo workflow checkpoints" },
	{ name: "delegate / delegate_inline / list_subagents", summary: "spawn a named or ad-hoc subagent in an isolated context" },
	{ name: "find_files", summary: "fd wrapper (respects .gitignore)" },
	{ name: "git_diff_preview", summary: "git diff with per-file truncation" },
	{ name: "memory_save / _recall / _search / _list / _forget", summary: "persistent memory" },
	{ name: "screenshot", summary: "macOS screencapture → image (full / selection / window)" },
	{ name: "watch_pr / watch_run / watch_list / watch_stop", summary: "agent-callable background watches for PRs/workflow runs (same backing as /tcc:watch)" },
	{ name: "search_text", summary: "ripgrep wrapper (respects .gitignore, smart-case)" },
];

export default function helpExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc", {
		description: "Show the tcc-specific commands, tools, and environment knobs (separate from pi's built-in /help).",
		handler: async (_args, ctx) => {
			const lines: string[] = ["## tcc commands"];
			for (const c of TCC_COMMANDS) lines.push(`  ${c.name.padEnd(14)} ${c.summary}`);
			lines.push("");
			lines.push("## tcc tools (LLM-callable)");
			for (const t of TCC_TOOLS) lines.push(`  ${t.name}`);
			lines.push("");
			lines.push("## env knobs");
			lines.push("  TCC_HOME=<path>               repo root (auto-detected from bin/tcc location)");
			lines.push("  TCC_DEFAULT_MODEL=<arn>       override default Bedrock ARN");
			lines.push("  TCC_DEFAULT_THEME=<name>      tokyo-night | catppuccin-mocha | gruvbox-dark | dark | light");
			lines.push("  TCC_SKIP_SSO=1                skip the SSO pre-flight in bin/tcc");
			lines.push("  TCC_AUTO_LOGIN=0              disable wrapper auto-running `aws sso login` on expiry");
			lines.push("  TCC_AUTO_UPDATE_PI=0          disable patch-only auto-update of pi (default: enabled, 6h cache)");
			lines.push("  TCC_DEBUG=1                   write per-event JSONL to ~/.tcc/debug/<session>.log");
			lines.push("  TCC_MEASURE_TWICE=1           review gated tool calls with a second model before executing");
			lines.push("  PI_CACHE_RETENTION=long|short Bedrock prompt-cache TTL (default: long, 1h)");
			lines.push("  AWS_BEDROCK_FORCE_CACHE=1     force cache_control on inference-profile ARNs (default: on)");
			lines.push("");
			lines.push("## tcc subcommands");
			lines.push("  tcc init                       bootstrap ~/.tcc/ with defaults + auto-detected MCP servers");
			lines.push("  tcc doctor [--deep]            check prerequisites (node, pi, aws CLI/SSO, ARNs, CLI tools, MCP)");
			lines.push("  tcc auth                       print AWS SSO auth history + lifetime stats");
			lines.push("  tcc login [profile]            refresh AWS SSO session (defaults to claude-code-bedrock)");
			lines.push("  tcc update                     git pull + npm install in $TCC_HOME");
			lines.push("  tcc mcp list|catalog|add|...   manage ~/.tcc/mcp.json (see `tcc mcp` for full usage)");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
