import { execFile as execFileCb, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig, type McpServerConfig, pluginsCacheDir } from "./config.ts";

const execFile = promisify(execFileCb);
const REFRESH_TTL_MS = 60 * 60 * 1000; // 1 hour — keep upstream changes flowing without paying the cost each invocation

interface MarketplaceEntry {
	name: string;
	source: string;
	description?: string;
	version?: string;
}

interface Marketplace {
	name: string;
	owner?: { name?: string };
	plugins: MarketplaceEntry[];
}

export interface DiscoveredPlugin {
	id: string;
	marketplace: string;
	name: string;
	root: string;
	description?: string;
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		console.error(`[tcc] failed to parse ${path}: ${(err as Error).message}`);
		return undefined;
	}
}

async function ensureRepo(name: string, repo: string): Promise<string | undefined> {
	const dest = join(pluginsCacheDir(), name);
	const stamp = join(dest, ".tcc-fetch-stamp");
	const gitDir = join(dest, ".git");

	const gitExists = await stat(gitDir).then(() => true).catch(() => false);
	if (gitExists) {
		const lastFetch = await stat(stamp).then((s) => s.mtimeMs).catch(() => 0);
		if (Date.now() - lastFetch < REFRESH_TTL_MS) return dest;
		try {
			await execFile("git", ["-C", dest, "fetch", "--quiet", "--depth", "1", "origin"]);
			const { stdout: branch } = await execFile("git", ["-C", dest, "symbolic-ref", "--short", "HEAD"]);
			await execFile("git", ["-C", dest, "reset", "--hard", "--quiet", `origin/${branch.trim()}`]);
			utimesSync(stamp, new Date(), new Date());
		} catch {
			// Offline or repo in unexpected state — keep using whatever's on disk.
		}
		try {
			writeFileSync(stamp, "");
		} catch {
			// Stamp is best-effort; if it can't be written we'll just refresh more often than needed.
		}
		return dest;
	}

	process.stderr.write(`[tcc] cloning ${repo}…\n`);
	try {
		mkdirSync(dirname(dest), { recursive: true });
		await execFile("git", ["clone", "--depth", "1", `https://github.com/${repo}.git`, dest]);
		writeFileSync(stamp, "");
		return dest;
	} catch (err) {
		const msg = (err as Error).message;
		// 403/404/auth-required all surface as a non-zero git clone exit. The marketplace
		// is simply skipped — other marketplaces still load.
		const looksLikeAuth = /403|404|not found|authentication|permission denied/i.test(msg);
		const hint = looksLikeAuth
			? " (likely private repo without access or missing auth — try `gh auth login`, or remove this marketplace from ~/.tcc/config.json)"
			: "";
		console.error(`[tcc] skipping marketplace '${repo}': clone failed${hint}`);
		return undefined;
	}
}

/** List every plugin in every marketplace, with the current enabled flag. Unlike
 *  discoverPlugins (which filters disabled + dedupes across marketplaces), this is
 *  the inventory view used by /tcc:plugin to show what *could* be loaded. */
export async function enumerateAllPlugins(): Promise<{ id: string; marketplace: string; name: string; description?: string; enabled: boolean }[]> {
	const cfg = loadConfig();
	const roots = await Promise.all(cfg.marketplaces.map(async (m) => ({ marketplace: m, root: await ensureRepo(m.name, m.repo) })));
	const out: { id: string; marketplace: string; name: string; description?: string; enabled: boolean }[] = [];
	for (const { marketplace: m, root } of roots) {
		if (!root) continue;
		const mk = readJson<Marketplace>(join(root, ".claude-plugin", "marketplace.json"));
		if (!mk) continue;
		for (const entry of mk.plugins) {
			const id = `${entry.name}@${mk.name}`;
			out.push({ id, marketplace: mk.name, name: entry.name, description: entry.description, enabled: cfg.enabledPlugins[id] !== false });
		}
	}
	return out;
}

async function discoverPlugins(): Promise<DiscoveredPlugin[]> {
	const cfg = loadConfig();
	const roots = await Promise.all(cfg.marketplaces.map(async (m) => ({ marketplace: m, root: await ensureRepo(m.name, m.repo) })));
	const skipped = roots.filter((r) => !r.root).length;
	if (skipped > 0) {
		console.error(`[tcc] ${skipped}/${cfg.marketplaces.length} marketplace(s) skipped (see warnings above); loading from the remaining ${cfg.marketplaces.length - skipped}`);
	}
	const out: DiscoveredPlugin[] = [];
	const seenNames = new Set<string>();
	for (const { marketplace: m, root } of roots) {
		if (!root) continue;
		const mk = readJson<Marketplace>(join(root, ".claude-plugin", "marketplace.json"));
		if (!mk) continue;
		for (const entry of mk.plugins) {
			const pluginRoot = join(root, entry.source);
			try {
				statSync(pluginRoot);
			} catch {
				console.error(`[tcc] plugin source missing: ${pluginRoot}`);
				continue;
			}
			const id = `${entry.name}@${mk.name}`;
			if (cfg.enabledPlugins[id] === false) continue;
			// Dedupe across marketplaces: first occurrence by plugin name wins.
			// Marketplace order in `~/.tcc/config.json` decides who's authoritative
			// when the same plugin appears in multiple marketplaces.
			if (seenNames.has(entry.name)) {
				console.error(`[tcc] skipping ${id} — '${entry.name}' already loaded from earlier marketplace`);
				continue;
			}
			seenNames.add(entry.name);
			out.push({ id, marketplace: mk.name, name: entry.name, root: pluginRoot, description: entry.description });
		}
	}
	return out;
}

/** Best-effort fix for the single most common SKILL.md frontmatter mistake: an unquoted
 *  scalar value containing `: ` (which YAML reads as a nested mapping). We only touch
 *  top-level frontmatter lines whose value is unquoted and not a block scalar.
 *  Returns the rewritten content, or null if nothing needed rewriting. */
function rescueFrontmatter(raw: string): string | null {
	const m = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
	if (!m) return null;
	const [, fm, body] = m;
	let touched = false;
	const fixed = fm
		.split("\n")
		.map((line) => {
			const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s+(.*)$/);
			if (!kv) return line;
			const [, key, val] = kv;
			const trimmed = val.trim();
			if (!trimmed || /^["'>|[{]/.test(trimmed)) return line; // already quoted, block scalar, flow seq/map
			if (!trimmed.includes(": ")) return line;
			const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			touched = true;
			return `${key}: "${escaped}"`;
		})
		.join("\n");
	return touched ? `---\n${fixed}\n---\n${body}` : null;
}

function collectSkills(pluginRoot: string): string[] {
	const skillsDir = join(pluginRoot, "skills");
	let entries: string[];
	try {
		entries = readdirSync(skillsDir);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		const skillFile = join(skillsDir, entry, "SKILL.md");
		let raw: string;
		try {
			raw = readFileSync(skillFile, "utf8");
		} catch {
			continue;
		}
		try {
			parseFrontmatter(raw);
			out.push(skillFile);
			continue;
		} catch (err) {
			const rescued = rescueFrontmatter(raw);
			if (rescued) {
				try {
					parseFrontmatter(rescued);
					writeFileSync(skillFile, rescued, "utf8");
					console.error(`[tcc] rescued malformed frontmatter in ${skillFile}`);
					out.push(skillFile);
					continue;
				} catch {
					// fall through to skip
				}
			}
			console.error(`[tcc] skipping ${skillFile} — frontmatter parse error: ${(err as Error).message.split("\n")[0]}`);
		}
	}
	return out;
}

interface ParsedCommand {
	pluginName: string;
	commandName: string;
	description: string;
	body: string;
}

function collectCommands(plugin: DiscoveredPlugin): ParsedCommand[] {
	const dir = join(plugin.root, "commands");
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return [];
	}
	const out: ParsedCommand[] = [];
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		const path = join(dir, file);
		try {
			const { frontmatter, body } = parseFrontmatter<{ description?: string; "argument-hint"?: string }>(readFileSync(path, "utf8"));
			out.push({
				pluginName: plugin.name,
				commandName: basename(file, ".md"),
				description: frontmatter.description ?? `Command from ${plugin.name}`,
				body: body.trim(),
			});
		} catch (err) {
			console.error(`[tcc] failed to parse command ${path}: ${(err as Error).message}`);
		}
	}
	return out;
}

function collectMcp(plugin: DiscoveredPlugin): Record<string, McpServerConfig> {
	const raw = readJson<{ mcpServers?: Record<string, McpServerConfig> }>(join(plugin.root, ".mcp.json"));
	if (!raw?.mcpServers) return {};
	const out: Record<string, McpServerConfig> = {};
	for (const [name, cfg] of Object.entries(raw.mcpServers)) {
		out[`${plugin.name}__${name}`] = cfg;
	}
	return out;
}

interface HookEntry {
	matcher?: string;
	hooks: { type: "command"; command: string; timeout?: number }[];
}
interface HooksFile {
	hooks?: Record<string, HookEntry[]>;
}

function collectHooks(plugin: DiscoveredPlugin): HooksFile {
	return readJson<HooksFile>(join(plugin.root, "hooks", "hooks.json")) ?? {};
}

function registerCommand(pi: ExtensionAPI, plugin: DiscoveredPlugin, cmd: ParsedCommand): void {
	pi.registerCommand(`${plugin.name}:${cmd.commandName}`, {
		description: cmd.description,
		handler: async (args) => {
			pi.sendUserMessage(cmd.body.replace(/\$ARGUMENTS/g, args.trim()));
		},
	});
}

type HookKind = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
interface HookBinding {
	event: "tool_call" | "tool_result" | "before_agent_start" | "agent_end";
	envFor: (event: unknown, ctx: ExtensionContext) => Record<string, string>;
}

const HOOK_BINDINGS: Record<HookKind, HookBinding> = {
	PreToolUse: {
		event: "tool_call",
		envFor: (e, ctx) => {
			const ev = e as ToolCallEvent;
			return { CLAUDE_PROJECT_DIR: ctx.cwd, CLAUDE_TOOL_NAME: ev.toolName, CLAUDE_TOOL_INPUT: JSON.stringify(ev.input) };
		},
	},
	PostToolUse: {
		event: "tool_result",
		envFor: (e, ctx) => ({ CLAUDE_PROJECT_DIR: ctx.cwd, CLAUDE_TOOL_NAME: (e as { toolName: string }).toolName }),
	},
	UserPromptSubmit: {
		event: "before_agent_start",
		envFor: (e, ctx) => ({ CLAUDE_PROJECT_DIR: ctx.cwd, CLAUDE_USER_PROMPT: (e as { prompt: string }).prompt }),
	},
	Stop: {
		event: "agent_end",
		envFor: (_e, ctx) => ({ CLAUDE_PROJECT_DIR: ctx.cwd }),
	},
};

function registerHooks(pi: ExtensionAPI, plugin: DiscoveredPlugin, hooks: HooksFile): void {
	const fire = (entries: HookEntry[] | undefined, env: Record<string, string>) => {
		if (!entries) return;
		for (const entry of entries) {
			for (const h of entry.hooks) {
				try {
					execFileSync("/bin/sh", ["-c", h.command], { env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"], timeout: (h.timeout ?? 30) * 1000 });
				} catch (err) {
					console.error(`[tcc hook ${plugin.name}] ${h.command} failed: ${(err as Error).message}`);
				}
			}
		}
	};
	for (const [kind, binding] of Object.entries(HOOK_BINDINGS) as [HookKind, HookBinding][]) {
		const entries = hooks.hooks?.[kind];
		if (!entries) continue;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		pi.on(binding.event as any, async (event: unknown, ctx: ExtensionContext) => {
			fire(entries, binding.envFor(event, ctx));
		});
	}
}

export interface PluginsResult {
	pluginCount: number;
	mcpServers: Record<string, McpServerConfig>;
}

export default async function pluginsExtension(pi: ExtensionAPI): Promise<PluginsResult> {
	const plugins = await discoverPlugins();
	console.error(`[tcc] loaded ${plugins.length} plugins from ${loadConfig().marketplaces.length} marketplaces`);

	const allSkillPaths = plugins.flatMap((p) => collectSkills(p.root));
	if (allSkillPaths.length > 0) {
		pi.on("resources_discover", () => ({ skillPaths: allSkillPaths }));
	}

	for (const plugin of plugins) {
		for (const cmd of collectCommands(plugin)) registerCommand(pi, plugin, cmd);
		const hooks = collectHooks(plugin);
		if (hooks.hooks) registerHooks(pi, plugin, hooks);
	}

	const mcpServers: Record<string, McpServerConfig> = {};
	for (const plugin of plugins) Object.assign(mcpServers, collectMcp(plugin));
	return { pluginCount: plugins.length, mcpServers };
}
