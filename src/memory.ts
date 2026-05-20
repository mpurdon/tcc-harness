import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findGitRoot, userConfigDir } from "./config.ts";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemorySource = "global" | "project" | "claude-code";

export interface MemoryRecord {
	name: string;
	type: MemoryType;
	description: string;
	body: string;
	source: MemorySource;
	path: string;
}

const TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

const slugify = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64) || "memory";

let globalDirEnsured = false;
function globalDir(): string {
	const dir = join(userConfigDir(), "memory");
	if (!globalDirEnsured) {
		mkdirSync(dir, { recursive: true });
		globalDirEnsured = true;
	}
	return dir;
}

const projectDirCache = new Map<string, string>();
function projectDir(cwd: string): string | undefined {
	const root = findGitRoot(cwd);
	if (!root) return undefined;
	const cached = projectDirCache.get(root);
	if (cached) return cached;
	const dir = join(root, ".tcc", "memory");
	mkdirSync(dir, { recursive: true });
	projectDirCache.set(root, dir);
	return dir;
}

/** Claude Code stores per-project memory at ~/.claude/projects/<encoded-cwd>/memory/
 *  where encoded-cwd replaces '/' with '-' and is prefixed with '-'. */
function claudeCodeDir(cwd: string): string | undefined {
	const dir = join(homedir(), ".claude", "projects", resolve(cwd).replace(/\//g, "-"), "memory");
	try {
		statSync(dir);
		return dir;
	} catch {
		return undefined;
	}
}

function listDir(dir: string, source: MemorySource): MemoryRecord[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((f) => f.endsWith(".md") && f.toLowerCase() !== "memory.md")
		.map((f) => parseFile(join(dir, f), source))
		.filter((m): m is MemoryRecord => m !== null);
}

function parseFile(path: string, source: MemorySource): MemoryRecord | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const { frontmatter, body } = parseFrontmatter<{ name?: string; description?: string; metadata?: { type?: MemoryType } }>(raw);
		const name = frontmatter.name ?? path.split("/").pop()!.replace(/\.md$/, "");
		const type = (frontmatter.metadata?.type ?? "project") as MemoryType;
		return {
			name,
			type: TYPES.includes(type) ? type : "project",
			description: frontmatter.description ?? "",
			body: body.trim(),
			source,
			path,
		};
	} catch {
		return null;
	}
}

interface CacheEntry {
	records: MemoryRecord[];
	signature: string;
}
const loadAllCache = new Map<string, CacheEntry>();

function dirSignature(dir: string | undefined): string {
	if (!dir) return "";
	try {
		const s = statSync(dir);
		return `${dir}:${s.mtimeMs}`;
	} catch {
		return "";
	}
}

/** Precedence on slug collisions: project > claude-code > global.
 *  claude-code is the existing ~/.claude memory for the same cwd — auto-imported
 *  so existing knowledge carries over without manual migration. */
export function loadAll(cwd: string): MemoryRecord[] {
	const g = globalDir();
	const cc = claudeCodeDir(cwd);
	const p = projectDir(cwd);
	const sig = [dirSignature(g), dirSignature(cc), dirSignature(p)].join("|");
	const cached = loadAllCache.get(cwd);
	if (cached && cached.signature === sig) return cached.records;

	const global = listDir(g, "global");
	const claudeCode = cc ? listDir(cc, "claude-code") : [];
	const project = p ? listDir(p, "project") : [];
	const map = new Map<string, MemoryRecord>();
	for (const m of global) map.set(m.name, m);
	for (const m of claudeCode) map.set(m.name, m);
	for (const m of project) map.set(m.name, m);
	const records = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
	loadAllCache.set(cwd, { records, signature: sig });
	return records;
}

function invalidateCache(cwd: string): void {
	loadAllCache.delete(cwd);
}

export function renderIndex(records: MemoryRecord[]): string {
	if (records.length === 0) return "";
	const lines = ["## Active memory", ""];
	for (const r of records) {
		const tag = r.source === "project" ? "[project]" : r.source === "claude-code" ? "[claude-code]" : "[global]";
		lines.push(`- **${r.name}** ${tag} (${r.type}) — ${r.description || "(no description)"}`);
	}
	lines.push("");
	lines.push("Use `memory_recall(name)` to read full bodies. Save new ones with `memory_save`.");
	return lines.join("\n");
}

interface WriteOptions {
	dir: string;
	source: MemorySource;
	name: string;
	type: MemoryType;
	description: string;
	body: string;
}

function writeMemory({ dir, source, name, type, description, body }: WriteOptions): MemoryRecord {
	const slug = slugify(name);
	const file = join(dir, `${slug}.md`);
	const fm = ["---", `name: ${slug}`, `description: ${description.replace(/\n/g, " ")}`, "metadata:", `  type: ${type}`, "---", ""].join("\n");
	writeFileSync(file, `${fm}${body.trim()}\n`, "utf8");
	return { name: slug, type, description, body: body.trim(), source, path: file };
}

export default function memoryExtension(pi: ExtensionAPI) {
	// Inject the memory index into the system prompt on every turn so it always reflects the latest state.
	// Cache-stable within a session: loadAll() is mtime-cached, so when no memory files have changed the
	// returned record list is reference-equal and renderIndex produces the same string — Bedrock prompt
	// caching keeps hitting. A memory_save/memory_forget mid-session intentionally breaks the cache for
	// that one turn (the writer invalidates the loadAll cache), which is correct: the model needs to see
	// the new state. Don't add anything to the rendered index that changes per turn (e.g. timestamps).
	pi.on("before_agent_start", (event, ctx) => {
		const index = renderIndex(loadAll(ctx.cwd));
		if (!index) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${index}` };
	});

	pi.registerTool({
		name: "memory_save",
		label: "Save memory",
		description:
			"Persist a memory record. Use for user preferences, feedback, project facts, and references that should outlive a single session. " +
			"Choose `scope: 'project'` for repo-specific notes (saved under <git-root>/.tcc/memory/), 'global' otherwise.",
		parameters: Type.Object({
			name: Type.String({ description: "Short kebab-case slug, e.g. 'user-prefers-terse'." }),
			type: Type.Union([Type.Literal("user"), Type.Literal("feedback"), Type.Literal("project"), Type.Literal("reference")]),
			description: Type.String({ description: "One-line summary used to decide relevance later." }),
			body: Type.String({ description: "Full memory body in markdown." }),
			scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const scope = params.scope ?? "global";
			const dir = scope === "project" ? projectDir(ctx.cwd) : globalDir();
			if (!dir) {
				return { content: [{ type: "text", text: "no project scope — not inside a git repo" }], details: undefined, isError: true };
			}
			const rec = writeMemory({ dir, source: scope, name: params.name, type: params.type, description: params.description, body: params.body });
			invalidateCache(ctx.cwd);
			return { content: [{ type: "text", text: `saved ${rec.name} (${rec.type}, ${scope}) → ${rec.path}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "memory_recall",
		label: "Recall memory",
		description: "Return the full body of a memory by name. Use after seeing a name in the active-memory index.",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, params, _s, _u, ctx) {
			const hit = loadAll(ctx.cwd).find((m) => m.name === params.name);
			if (!hit) return { content: [{ type: "text", text: `no memory named '${params.name}'` }], details: undefined, isError: true };
			return { content: [{ type: "text", text: `[${hit.source}/${hit.type}] ${hit.description}\n\n${hit.body}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Search memory",
		description: "Substring search across all memory names, descriptions, and bodies. Use before asking the user to repeat themselves.",
		parameters: Type.Object({ query: Type.String() }),
		async execute(_id, params, _s, _u, ctx) {
			const q = params.query.toLowerCase();
			const hits = loadAll(ctx.cwd).filter(
				(m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) || m.body.toLowerCase().includes(q),
			);
			if (hits.length === 0) return { content: [{ type: "text", text: `no matches for '${params.query}'` }], details: undefined };
			const lines = hits.map((m) => `- ${m.name} [${m.source}/${m.type}] — ${m.description}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "memory_list",
		label: "List memory",
		description: "List all known memory records (global + project) sorted by name.",
		parameters: Type.Object({}),
		async execute(_id, _params, _s, _u, ctx) {
			const records = loadAll(ctx.cwd);
			if (records.length === 0) return { content: [{ type: "text", text: "no memory yet" }], details: undefined };
			return { content: [{ type: "text", text: renderIndex(records) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Forget memory",
		description: "Delete a memory by name. Prefer this over leaving stale or wrong notes around.",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, params, _s, _u, ctx) {
			const hit = loadAll(ctx.cwd).find((m) => m.name === params.name);
			if (!hit) return { content: [{ type: "text", text: `no memory named '${params.name}'` }], details: undefined, isError: true };
			unlinkSync(hit.path);
			invalidateCache(ctx.cwd);
			return { content: [{ type: "text", text: `forgot ${hit.name} (was at ${hit.path})` }], details: undefined };
		},
	});

	pi.registerCommand("tcc:remember", {
		description: "Save something to long-term memory (the agent picks slug + type).",
		handler: async (args) => {
			const text = args.trim();
			if (!text) return;
			pi.sendUserMessage(
				`Save this to memory using the memory_save tool. Pick an appropriate name, type (user|feedback|project|reference), description, and decide scope (global vs project). Content:\n\n${text}`,
			);
		},
	});

	pi.registerCommand("tcc:forget", {
		description: "Forget a memory by name.",
		handler: async (args) => {
			const name = args.trim();
			if (!name) return;
			pi.sendUserMessage(`Forget the memory named '${name}' using the memory_forget tool.`);
		},
	});
}
