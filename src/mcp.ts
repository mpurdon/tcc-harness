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

function cachePath(server: ManagedServer): string {
	// Hash command+args so a server reconfig invalidates the cache automatically.
	const key = createHash("sha256").update(server.cfg.command).update("\0").update(JSON.stringify(server.cfg.args ?? [])).digest("hex").slice(0, 16);
	return join(userConfigDir(), "cache", "mcp-tools", `${server.name}-${key}.json`);
}

function readCache(server: ManagedServer): ToolDescriptor[] | undefined {
	const path = cachePath(server);
	if (!existsSync(path)) return undefined;
	try {
		if (Date.now() - statSync(path).mtimeMs > CACHE_TTL_MS) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as ToolDescriptor[];
		return Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function writeCache(server: ManagedServer, tools: ToolDescriptor[]): void {
	const path = cachePath(server);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(tools));
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

	let listed: { tools: ToolDescriptor[] };
	try {
		listed = await client.listTools();
	} catch (err) {
		console.error(`[tcc mcp] '${server.name}' listTools failed: ${(err as Error).message}`);
		await client.close().catch(() => undefined);
		scheduleRestart(pi, server, servers);
		return;
	}

	server.client = client;
	server.transport = transport;
	server.restartAttempt = 0;
	writeCache(server, listed.tools);
	const wasFresh = !server.toolsRegistered;
	registerToolsOnce(pi, server, listed.tools, servers);
	console.error(`[tcc mcp] '${server.name}' ${wasFresh ? "ready" : "reconnected"} (${listed.tools.length} tools)`);
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
		const server: ManagedServer = { name, cfg, client: undefined, transport: undefined, toolsRegistered: false, restartAttempt: 0, restartTimer: undefined, shuttingDown: false, pendingSpawn: undefined };
		servers.set(name, server);

		const cached = readCache(server);
		if (cached) {
			// Lazy path: register tools from cache, defer spawn until first invocation.
			registerToolsOnce(pi, server, cached, servers);
			console.error(`[tcc mcp] '${name}' lazy (${cached.length} tools cached; spawning on first use)`);
		} else {
			// Cold start: spawn synchronously so the cache gets populated for next time.
			eagerSpawns.push(ensureRunning(pi, server, servers));
		}
	}
	await Promise.all(eagerSpawns);
}
