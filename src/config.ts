import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * tcc config — loaded from ~/.tcc/config.json with sensible defaults.
 * Mirrors the shape of Claude Code's settings so users feel at home.
 */
export interface TccConfig {
	marketplaces: { name: string; repo: string }[];
	enabledPlugins: Record<string, boolean>;
	mcpServers: Record<string, McpServerConfig>;
	/** Last-selected theme name (persisted by /tcc:theme). Overridden by TCC_DEFAULT_THEME env var. */
	theme?: string;
	/** MCP behaviour knobs. */
	mcp?: McpOptions;
	/** User-defined extra status-line segment. */
	statusLine?: StatusLineOptions;
	/** Rolling session recap widget. */
	recap?: RecapOptions;
}

export interface RecapOptions {
	/** Show the recap widget. On by default; set false (or TCC_RECAP=0) to disable. */
	enabled?: boolean;
	/** Regenerate every N agent turns (also on resume). Default 5. */
	everyTurns?: number;
	/** Model for recap synthesis (sonnet|opus|haiku|ARN). Default haiku. */
	model?: string;
}

export interface StatusLineOptions {
	/** Shell command whose first stdout line becomes a status-line segment.
	 *  Receives TCC_SL_CWD / TCC_SL_MODEL / TCC_SL_AWS_PROFILE / TCC_SL_DOLLARS in env.
	 *  Also settable via TCC_STATUSLINE_CMD. */
	command?: string;
	/** Refresh cadence in ms (min 2000, default 10000). Also refreshes on each turn end. */
	intervalMs?: number;
}

export interface McpOptions {
	/** Defer MCP tool schemas out of the active tool list; the agent re-activates
	 *  them on demand via the mcp_find_tools meta-tool. Saves context/cache when many
	 *  MCP servers are configured. Off by default; TCC_MCP_DEFER_TOOLS=1 also enables. */
	deferTools?: boolean;
	/** Only defer when at least this many MCP tools are registered (default 1). */
	deferThreshold?: number;
}

export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

const DEFAULTS: TccConfig = {
	// Marketplaces are opt-in. `tcc init` offers known marketplaces interactively,
	// or you can add entries here manually: `{ name, repo: "owner/name" }`.
	marketplaces: [],
	enabledPlugins: {},
	mcpServers: {},
};

export function tccHome(): string {
	return process.env.TCC_HOME ?? resolve(import.meta.dirname, "..");
}

export function userConfigDir(): string {
	return join(homedir(), ".tcc");
}

export function pluginsCacheDir(): string {
	return join(tccHome(), "plugins-cache");
}

export function loadConfig(): TccConfig {
	const path = join(userConfigDir(), "config.json");
	if (!existsSync(path)) return DEFAULTS;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TccConfig>;
		return {
			marketplaces: raw.marketplaces ?? DEFAULTS.marketplaces,
			enabledPlugins: raw.enabledPlugins ?? DEFAULTS.enabledPlugins,
			mcpServers: raw.mcpServers ?? DEFAULTS.mcpServers,
			theme: raw.theme,
			mcp: raw.mcp,
			statusLine: raw.statusLine,
			recap: raw.recap,
		};
	} catch (err) {
		console.error(`[tcc] failed to parse ${path}: ${(err as Error).message} — using defaults`);
		return DEFAULTS;
	}
}

/** Walk up from `cwd` looking for the nearest .git directory; return its parent or undefined. */
export function findGitRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
