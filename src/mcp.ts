import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type McpServerConfig, userConfigDir } from "./config.ts";

interface ManagedServer {
	name: string;
	cfg: McpServerConfig;
	client: Client | undefined;
	transport: StdioClientTransport | undefined;
	toolsRegistered: boolean;
	promptsRegistered: boolean;
	resourcesRegistered: boolean;
	restartAttempt: number;
	restartTimer: NodeJS.Timeout | undefined;
	shuttingDown: boolean;
	pendingSpawn: Promise<void> | undefined;
}

const INHERITED_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION"] as const;
const MAX_RESTART_ATTEMPTS = 5;
const CACHE_TTL_MS = 7 * 24 * 3600_000;

function jsonSchemaToTypeBox(schema: unknown): TSchema {
	if (!schema || typeof schema !== "object") return Type.Object({});
	const s = schema as Record<string, unknown>;
	if (s.type === "object" || s.properties) {
		const props = (s.properties as Record<string, unknown>) ?? {};
		const required = new Set((s.required as string[]) ?? []);
		const out: Record<string, TSchema> = {};
		for (const [k, v] of Object.entries(props)) {
			const child = jsonSchemaToTypeBox(v);
			out[k] = required.has(k) ? child : Type.Optional(child);
		}
		return Type.Object(out, { additionalProperties: s.additionalProperties === true });
	}
	if (s.type === "array") return Type.Array(jsonSchemaToTypeBox(s.items));
	if (s.type === "string") return Type.String(s.description ? { description: String(s.description) } : {});
	if (s.type === "number" || s.type === "integer") return Type.Number();
	if (s.type === "boolean") return Type.Boolean();
	if (Array.isArray(s.enum)) return Type.Union(s.enum.map((e) => Type.Literal(e as string | number | boolean)));
	return Type.Any();
}

function envWithExpansion(env: Record<string, string> | undefined): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const k of INHERITED_ENV) {
		const v = process.env[k];
		if (v) merged[k] = v;
	}
	if (env) {
		for (const [k, v] of Object.entries(env)) {
			merged[k] = v.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (_, name) => process.env[name] ?? "");
		}
	}
	return merged;
}

interface ToolDescriptor {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

interface PromptArg {
	name: string;
	description?: string;
	required?: boolean;
}

interface PromptDescriptor {
	name: string;
	description?: string;
	arguments?: PromptArg[];
}

// Everything we discover from a server in one shot, so the lazy-boot cache can
// register tools, prompt slash-commands, and resource tools without re-spawning.
interface ServerCaps {
	tools: ToolDescriptor[];
	prompts: PromptDescriptor[];
	hasResources: boolean;
}

function emptyCaps(): ServerCaps {
	return { tools: [], prompts: [], hasResources: false };
}

function cachePath(server: ManagedServer): string {
	// Hash command+args so a server reconfig invalidates the cache automatically.
	const key = createHash("sha256").update(server.cfg.command).update("\0").update(JSON.stringify(server.cfg.args ?? [])).digest("hex").slice(0, 16);
	return join(userConfigDir(), "cache", "mcp-tools", `${server.name}-${key}.json`);
}

function readCache(server: ManagedServer): ServerCaps | undefined {
	const path = cachePath(server);
	if (!existsSync(path)) return undefined;
	try {
		if (Date.now() - statSync(path).mtimeMs > CACHE_TTL_MS) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		// Legacy cache was a bare ToolDescriptor[] (tools only) — upgrade in place.
		if (Array.isArray(parsed)) return { tools: parsed as ToolDescriptor[], prompts: [], hasResources: false };
		if (parsed && typeof parsed === "object" && Array.isArray((parsed as ServerCaps).tools)) {
			const p = parsed as ServerCaps;
			return { tools: p.tools, prompts: Array.isArray(p.prompts) ? p.prompts : [], hasResources: Boolean(p.hasResources) };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function writeCache(server: ManagedServer, caps: ServerCaps): void {
	const path = cachePath(server);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(caps));
	} catch {
		// Cache miss next time — not load-bearing.
	}
}

function registerToolsOnce(pi: ExtensionAPI, server: ManagedServer, tools: ToolDescriptor[], servers: Map<string, ManagedServer>): void {
	if (server.toolsRegistered) return;
	server.toolsRegistered = true;
	for (const tool of tools) {
		const fullName = `mcp__${server.name}__${tool.name}`;
		pi.registerTool({
			name: fullName,
			label: `${server.name} · ${tool.name}`,
			description: tool.description ?? `MCP tool ${tool.name} from server ${server.name}`,
			parameters: jsonSchemaToTypeBox(tool.inputSchema),
			async execute(_id, params, signal) {
				const mc = servers.get(server.name);
				if (!mc) {
					return { content: [{ type: "text", text: `mcp server '${server.name}' unknown` }], details: undefined, isError: true };
				}
				if (!mc.client) {
					// Lazy boot — first call triggers the actual spawn.
					await ensureRunning(pi, mc, servers);
				}
				const live = servers.get(server.name)?.client;
				if (!live) {
					return { content: [{ type: "text", text: `mcp server '${server.name}' is offline (auto-restart in progress)` }], details: undefined, isError: true };
				}
				try {
					const res = await live.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, undefined, { signal });
					const content = Array.isArray(res.content) ? res.content : [];
					return {
						content: content.map((c: { type: string; text?: unknown; mimeType?: string; data?: string }) =>
							c.type === "text"
								? { type: "text" as const, text: String(c.text) }
								: c.type === "image"
									? { type: "image" as const, mimeType: c.mimeType ?? "image/png", data: String(c.data ?? "") }
									: { type: "text" as const, text: JSON.stringify(c) },
						),
						details: undefined,
						isError: Boolean(res.isError),
					};
				} catch (err) {
					return { content: [{ type: "text", text: `mcp call '${fullName}' failed: ${(err as Error).message}` }], details: undefined, isError: true };
				}
			},
		});
	}
}

// Server prompts become `/mcp__<server>__<prompt>` slash commands, matching
// Claude Code's naming. Arguments are positional, whitespace-separated; the last
// declared argument absorbs any trailing tokens so prose still works.
function registerPromptsOnce(pi: ExtensionAPI, server: ManagedServer, prompts: PromptDescriptor[], servers: Map<string, ManagedServer>): void {
	if (server.promptsRegistered) return;
	server.promptsRegistered = true;
	for (const prompt of prompts) {
		const cmdName = `mcp__${server.name}__${prompt.name}`;
		const argNames = (prompt.arguments ?? []).map((a) => a.name);
		const usage = argNames.length ? ` (args: ${argNames.join(" ")})` : "";
		pi.registerCommand(cmdName, {
			description: `${prompt.description ?? `MCP prompt ${prompt.name}`} — from ${server.name}${usage}`,
			handler: async (args, ctx) => {
				const mc = servers.get(server.name);
				if (!mc) {
					ctx.ui.notify(`mcp server '${server.name}' unknown`, "error");
					return;
				}
				if (!mc.client) await ensureRunning(pi, mc, servers);
				const live = servers.get(server.name)?.client;
				if (!live) {
					ctx.ui.notify(`mcp server '${server.name}' is offline (auto-restart in progress)`, "error");
					return;
				}
				const argObj = parsePromptArgs(args, argNames);
				try {
					const res = await live.getPrompt({ name: prompt.name, arguments: argObj });
					const text = promptMessagesToText(res.messages);
					if (!text.trim()) {
						ctx.ui.notify(`mcp prompt '${prompt.name}' returned no text content`, "error");
						return;
					}
					pi.sendUserMessage(text, { deliverAs: "followUp" });
				} catch (err) {
					ctx.ui.notify(`mcp prompt '${prompt.name}' failed: ${(err as Error).message}`, "error");
				}
			},
		});
	}
}

function parsePromptArgs(args: string, argNames: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	const trimmed = args.trim();
	if (!trimmed || argNames.length === 0) return out;
	const tokens = trimmed.split(/\s+/);
	argNames.forEach((name, i) => {
		if (i < argNames.length - 1) {
			if (tokens[i] !== undefined) out[name] = tokens[i];
		} else {
			// last arg soaks up the remaining tokens (so multi-word values work)
			const rest = tokens.slice(i).join(" ");
			if (rest) out[name] = rest;
		}
	});
	return out;
}

function promptMessagesToText(messages: { role: string; content: unknown }[] | undefined): string {
	if (!Array.isArray(messages)) return "";
	const parts: string[] = [];
	for (const m of messages) {
		const c = m.content as { type?: string; text?: unknown } | { type?: string; text?: unknown }[] | undefined;
		const blocks = Array.isArray(c) ? c : c ? [c] : [];
		for (const b of blocks) {
			if (b?.type === "text" && b.text != null) parts.push(String(b.text));
		}
	}
	return parts.join("\n\n");
}

// Resources are URI-addressed and dynamic, so they don't fit pi's file-path
// resource discovery. Expose them as two tools the agent can call instead.
function registerResourceToolsOnce(pi: ExtensionAPI, server: ManagedServer, servers: Map<string, ManagedServer>): void {
	if (server.resourcesRegistered) return;
	server.resourcesRegistered = true;
	const live = (): Client | undefined => servers.get(server.name)?.client;
	const ensureLive = async (): Promise<Client | undefined> => {
		const mc = servers.get(server.name);
		if (mc && !mc.client) await ensureRunning(pi, mc, servers);
		return live();
	};

	pi.registerTool({
		name: `mcp__${server.name}__list_resources`,
		label: `${server.name} · list_resources`,
		description: `List resources exposed by the '${server.name}' MCP server (uri, name, description, mimeType).`,
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const c = await ensureLive();
			if (!c) return { content: [{ type: "text", text: `mcp server '${server.name}' offline` }], details: undefined, isError: true };
			try {
				const res = await c.listResources(undefined, { signal });
				const list = (res.resources ?? []).map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType }));
				return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }], details: undefined, isError: false };
			} catch (err) {
				return { content: [{ type: "text", text: `list_resources failed: ${(err as Error).message}` }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: `mcp__${server.name}__read_resource`,
		label: `${server.name} · read_resource`,
		description: `Read a resource from the '${server.name}' MCP server by URI (use list_resources to discover URIs).`,
		parameters: Type.Object({ uri: Type.String({ description: "resource URI, e.g. from list_resources" }) }),
		async execute(_id, params, signal) {
			const c = await ensureLive();
			if (!c) return { content: [{ type: "text", text: `mcp server '${server.name}' offline` }], details: undefined, isError: true };
			const uri = (params as { uri?: string }).uri ?? "";
			try {
				const res = await c.readResource({ uri }, { signal });
				const contents = Array.isArray(res.contents) ? res.contents : [];
				const out = contents.map((rc: { text?: unknown; blob?: unknown; mimeType?: string }) =>
					rc.text != null
						? { type: "text" as const, text: String(rc.text) }
						: { type: "text" as const, text: `[binary resource${rc.mimeType ? ` ${rc.mimeType}` : ""}, ${rc.blob ? `${String(rc.blob).length} b64 chars` : "no data"}]` },
				);
				return { content: out.length ? out : [{ type: "text", text: "(empty resource)" }], details: undefined, isError: false };
			} catch (err) {
				return { content: [{ type: "text", text: `read_resource '${uri}' failed: ${(err as Error).message}` }], details: undefined, isError: true };
			}
		},
	});
}

function registerFromCaps(pi: ExtensionAPI, server: ManagedServer, caps: ServerCaps, servers: Map<string, ManagedServer>): void {
	registerToolsOnce(pi, server, caps.tools, servers);
	registerPromptsOnce(pi, server, caps.prompts, servers);
	if (caps.hasResources) registerResourceToolsOnce(pi, server, servers);
}

function scheduleRestart(pi: ExtensionAPI, server: ManagedServer, servers: Map<string, ManagedServer>): void {
	if (server.shuttingDown) return;
	if (server.restartAttempt >= MAX_RESTART_ATTEMPTS) {
		console.error(`[tcc mcp] '${server.name}' giving up after ${MAX_RESTART_ATTEMPTS} restart attempts — fix and rerun tcc`);
		return;
	}
	server.restartAttempt += 1;
	const delayMs = Math.min(30_000, 2 ** server.restartAttempt * 500);
	if (server.restartTimer) clearTimeout(server.restartTimer);
	console.error(`[tcc mcp] '${server.name}' will restart in ${(delayMs / 1000).toFixed(1)}s (attempt ${server.restartAttempt}/${MAX_RESTART_ATTEMPTS})`);
	server.restartTimer = setTimeout(() => {
		void ensureRunning(pi, server, servers);
	}, delayMs);
}

// Best-effort capability probe — servers that don't implement prompts/resources
// throw "Method not found", which we swallow (those just stay empty/false).
async function probeCaps(client: Client, tools: ToolDescriptor[]): Promise<ServerCaps> {
	const caps: ServerCaps = { tools, prompts: [], hasResources: false };
	try {
		const p = await client.listPrompts();
		caps.prompts = (p.prompts ?? []).map((pr) => ({ name: pr.name, description: pr.description, arguments: pr.arguments as PromptArg[] | undefined }));
	} catch {
		// no prompts capability
	}
	try {
		const r = await client.listResources();
		caps.hasResources = Array.isArray(r.resources) && r.resources.length > 0;
	} catch {
		// no resources capability
	}
	return caps;
}

async function spawnAndConnect(pi: ExtensionAPI, server: ManagedServer, servers: Map<string, ManagedServer>): Promise<void> {
	if (server.shuttingDown || server.client) return;

	const transport = new StdioClientTransport({
		command: server.cfg.command,
		args: server.cfg.args ?? [],
		env: envWithExpansion(server.cfg.env),
		cwd: server.cfg.cwd,
	});
	transport.onclose = () => {
		if (server.shuttingDown) return;
		if (server.transport !== transport) return; // already replaced
		console.error(`[tcc mcp] '${server.name}' transport closed unexpectedly`);
		server.client = undefined;
		server.transport = undefined;
		scheduleRestart(pi, server, servers);
	};
	transport.onerror = (err) => {
		console.error(`[tcc mcp] '${server.name}' transport error: ${err.message}`);
	};

	const client = new Client({ name: `tcc-mcp-${server.name}`, version: "0.1.0" }, { capabilities: {} });
	try {
		await client.connect(transport);
	} catch (err) {
		console.error(`[tcc mcp] '${server.name}' connect failed: ${(err as Error).message}`);
		scheduleRestart(pi, server, servers);
		return;
	}

	let tools: ToolDescriptor[];
	try {
		tools = (await client.listTools()).tools;
	} catch (err) {
		console.error(`[tcc mcp] '${server.name}' listTools failed: ${(err as Error).message}`);
		await client.close().catch(() => undefined);
		scheduleRestart(pi, server, servers);
		return;
	}

	const caps = await probeCaps(client, tools);
	server.client = client;
	server.transport = transport;
	server.restartAttempt = 0;
	writeCache(server, caps);
	const wasFresh = !server.toolsRegistered;
	registerFromCaps(pi, server, caps, servers);
	const extras = [caps.prompts.length ? `${caps.prompts.length} prompts` : "", caps.hasResources ? "resources" : ""].filter(Boolean).join(", ");
	console.error(`[tcc mcp] '${server.name}' ${wasFresh ? "ready" : "reconnected"} (${tools.length} tools${extras ? `, ${extras}` : ""})`);
}

/** Idempotent: returns immediately if already running, otherwise spawns. Concurrent
 *  callers share a single in-flight spawn promise so a parallel-tool-call burst doesn't
 *  start the same server twice. */
function ensureRunning(pi: ExtensionAPI, server: ManagedServer, servers: Map<string, ManagedServer>): Promise<void> {
	if (server.shuttingDown || server.client) return Promise.resolve();
	if (server.pendingSpawn) return server.pendingSpawn;
	const promise = spawnAndConnect(pi, server, servers).finally(() => {
		server.pendingSpawn = undefined;
	});
	server.pendingSpawn = promise;
	return promise;
}

function loadGlobalMcp(): Record<string, McpServerConfig> {
	const path = join(userConfigDir(), "mcp.json");
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
		return raw.mcpServers ?? {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		console.error(`[tcc mcp] failed to parse ${path}: ${(err as Error).message}`);
		return {};
	}
}

export default async function mcpExtension(pi: ExtensionAPI, pluginServers: Record<string, McpServerConfig> = {}): Promise<void> {
	const servers = new Map<string, ManagedServer>();

	const closeAll = async () => {
		for (const server of servers.values()) {
			server.shuttingDown = true;
			if (server.restartTimer) clearTimeout(server.restartTimer);
			await server.client?.close().catch(() => undefined);
		}
	};
	pi.on("session_shutdown", async () => {
		await closeAll();
	});
	process.once("SIGINT", () => void closeAll());
	process.once("SIGTERM", () => void closeAll());

	const all = { ...loadGlobalMcp(), ...pluginServers };
	const eagerSpawns: Promise<void>[] = [];
	for (const [name, cfg] of Object.entries(all)) {
		const server: ManagedServer = {
			name,
			cfg,
			client: undefined,
			transport: undefined,
			toolsRegistered: false,
			promptsRegistered: false,
			resourcesRegistered: false,
			restartAttempt: 0,
			restartTimer: undefined,
			shuttingDown: false,
			pendingSpawn: undefined,
		};
		servers.set(name, server);

		const cached = readCache(server);
		if (cached) {
			// Lazy path: register tools/prompts/resources from cache, defer spawn until first use.
			registerFromCaps(pi, server, cached, servers);
			const extras = [cached.prompts.length ? `${cached.prompts.length} prompts` : "", cached.hasResources ? "resources" : ""].filter(Boolean).join(", ");
			console.error(`[tcc mcp] '${name}' lazy (${cached.tools.length} tools${extras ? `, ${extras}` : ""} cached; spawning on first use)`);
		} else {
			// Cold start: spawn synchronously so the cache gets populated for next time.
			eagerSpawns.push(ensureRunning(pi, server, servers));
		}
	}
	await Promise.all(eagerSpawns);
}
