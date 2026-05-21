import { join } from "node:path";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import { tccHome, userConfigDir } from "./config.ts";
import { readJson, runProcess } from "./util.ts";

interface CatalogEntry {
	summary: string;
	requires?: string[];
}

interface McpFile {
	mcpServers?: Record<string, unknown>;
}

async function fetchCatalog(): Promise<Record<string, CatalogEntry> | undefined> {
	// Single source of truth for the catalog is scripts/lib/mcp-catalog.mjs. We
	// shell out to node so the picker reflects whatever the bash subcommand sees.
	const script = `
		import("${join(tccHome(), "scripts/lib/mcp-catalog.mjs")}").then((m) => {
			const out = {};
			for (const [name, entry] of Object.entries(m.CATALOG)) {
				out[name] = { summary: entry.summary, requires: entry.requires };
			}
			console.log(JSON.stringify(out));
		}).catch((e) => { console.error(e.message); process.exit(1); });
	`;
	const r = await runProcess({ cmd: "node", args: ["-e", script], timeoutMs: 5_000 });
	if (r.reason !== "exit" || r.exitCode !== 0) {
		console.error(`[tcc] mcp catalog snapshot failed: ${r.stderr || "(no stderr)"}`);
		return undefined;
	}
	try {
		return JSON.parse(r.stdout) as Record<string, CatalogEntry>;
	} catch {
		return undefined;
	}
}

function currentlyEnabled(): Set<string> {
	const cfg = readJson<McpFile>(join(userConfigDir(), "mcp.json"));
	return new Set(Object.keys(cfg?.mcpServers ?? {}));
}

async function tccMcp(action: "add" | "remove", name: string): Promise<{ ok: boolean; message: string }> {
	const tccBin = process.env.TCC_HOME ? join(process.env.TCC_HOME, "bin/tcc") : "tcc";
	const r = await runProcess({ cmd: tccBin, args: ["mcp", action, name], timeoutMs: 15_000 });
	const out = (r.stdout || r.stderr || "").trim().split("\n").slice(-1)[0] ?? "";
	if (r.reason !== "exit" || r.exitCode !== 0) return { ok: false, message: out || `tcc mcp ${action} ${name} failed` };
	return { ok: true, message: out };
}

async function openPicker(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/tcc:mcp: no UI (headless). Use `tcc mcp catalog|add|remove` instead.", "error");
		return;
	}
	const catalog = await fetchCatalog();
	if (!catalog || Object.keys(catalog).length === 0) {
		ctx.ui.notify("/tcc:mcp: catalog is empty or could not be read (see stderr)", "error");
		return;
	}
	const enabled = currentlyEnabled();
	const names = Object.keys(catalog).sort();
	const items = names.map((name) => {
		const entry = catalog[name];
		const reqStr = entry.requires?.length ? ` · needs ${entry.requires.join(", ")}` : "";
		return {
			id: name,
			label: name,
			description: `${entry.summary}${reqStr}`,
			currentValue: enabled.has(name) ? "enabled" : "disabled",
			values: ["enabled", "disabled"],
		};
	});

	const pending = new Map<string, boolean>();
	await ctx.ui.custom<void>((_tui, _theme, _kb, done) => {
		return new SettingsList(
			items,
			Math.min(items.length, 15),
			getSettingsListTheme(),
			(id, newValue) => { pending.set(id, newValue === "enabled"); },
			() => done(undefined),
		);
	});

	if (pending.size === 0) {
		ctx.ui.notify("no MCP changes", "info");
		return;
	}
	const added: string[] = [];
	const removed: string[] = [];
	const errors: string[] = [];
	for (const [name, want] of pending) {
		const before = enabled.has(name);
		if (want === before) continue;
		const result = await tccMcp(want ? "add" : "remove", name);
		if (!result.ok) errors.push(`${name}: ${result.message}`);
		else if (want) added.push(name);
		else removed.push(name);
	}

	const parts: string[] = [];
	if (added.length > 0) parts.push(`added: ${added.join(", ")}`);
	if (removed.length > 0) parts.push(`removed: ${removed.join(", ")}`);
	if (errors.length > 0) parts.push(`errors: ${errors.join("; ")}`);
	if (parts.length === 0) {
		ctx.ui.notify("no net MCP changes", "info");
		return;
	}
	ctx.ui.notify(`${parts.join(" · ")}. Restart tcc to (re)spawn servers.`, errors.length > 0 ? "error" : "info");
}

export default function mcpAdminExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:mcp", {
		description: "Toggle MCP servers from the built-in catalog via interactive checklist. For non-interactive use, the `tcc mcp` bash subcommand has list/catalog/show/add/remove.",
		handler: async (_args, ctx) => {
			await openPicker(ctx);
		},
	});
}
