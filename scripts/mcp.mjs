#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CATALOG } from "./lib/mcp-catalog.mjs";

const TCC_DIR = join(homedir(), ".tcc");
const MCP_PATH = join(TCC_DIR, "mcp.json");

function readMcp() {
	if (!existsSync(MCP_PATH)) return { mcpServers: {} };
	try {
		return JSON.parse(readFileSync(MCP_PATH, "utf8"));
	} catch (err) {
		console.error(`tcc mcp: failed to parse ${MCP_PATH}: ${err.message}`);
		process.exit(1);
	}
}

function writeMcp(data) {
	mkdirSync(TCC_DIR, { recursive: true });
	const tmp = `${MCP_PATH}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	renameSync(tmp, MCP_PATH);
}

function usage() {
	console.log(`tcc mcp — manage ~/.tcc/mcp.json

Commands:
  tcc mcp list              list currently configured servers
  tcc mcp catalog           list all servers available in the built-in catalog
  tcc mcp show <name>       print details for one catalog entry
  tcc mcp add <name>        add a catalog server to mcp.json (overwrites existing entry of same name)
  tcc mcp remove <name>     remove a server from mcp.json
`);
}

function cmdList() {
	const names = Object.keys(readMcp().mcpServers ?? {});
	if (names.length === 0) {
		console.log("(no servers configured)");
		return;
	}
	for (const name of names.sort()) {
		const s = readMcp().mcpServers[name];
		const summary = CATALOG[name]?.summary ?? "(custom)";
		console.log(`  ${name.padEnd(14)} ${s.command} ${(s.args ?? []).join(" ")}`);
		console.log(`                   ${summary}`);
	}
}

function cmdCatalog() {
	for (const [name, entry] of Object.entries(CATALOG)) {
		console.log(`  ${name.padEnd(14)} ${entry.summary}`);
		if (entry.requires?.length) console.log(`                   needs: ${entry.requires.join(", ")}`);
	}
}

function cmdShow(name) {
	const entry = CATALOG[name];
	if (!entry) {
		console.error(`tcc mcp: '${name}' is not in the built-in catalog`);
		process.exit(1);
	}
	console.log(`${name}\n  ${entry.summary}`);
	if (entry.requires) console.log(`  requires: ${entry.requires.join(", ")}`);
	try {
		const cfg = entry.config();
		console.log(`  config:\n${JSON.stringify(cfg, null, 4).replace(/^/gm, "    ")}`);
	} catch (err) {
		console.log(`  config: <cannot build right now — ${err.message}>`);
	}
}

function cmdAdd(name) {
	const entry = CATALOG[name];
	if (!entry) {
		console.error(`tcc mcp: '${name}' is not in the built-in catalog. Available: ${Object.keys(CATALOG).join(", ")}`);
		process.exit(1);
	}
	let cfg;
	try {
		cfg = entry.config();
	} catch (err) {
		console.error(`tcc mcp: cannot add '${name}' — ${err.message}`);
		process.exit(1);
	}
	const data = readMcp();
	data.mcpServers ??= {};
	data.mcpServers[name] = cfg;
	writeMcp(data);
	console.log(`tcc mcp: added '${name}' → ${MCP_PATH}`);
}

function cmdRemove(name) {
	const data = readMcp();
	if (!data.mcpServers?.[name]) {
		console.error(`tcc mcp: '${name}' is not currently configured`);
		process.exit(1);
	}
	delete data.mcpServers[name];
	writeMcp(data);
	console.log(`tcc mcp: removed '${name}'`);
}

// Subcommand dispatch — entries with `arg: true` require a positional argument.
const COMMANDS = {
	list: { fn: cmdList },
	catalog: { fn: cmdCatalog },
	show: { fn: cmdShow, arg: true },
	add: { fn: cmdAdd, arg: true },
	remove: { fn: cmdRemove, arg: true },
	rm: { fn: cmdRemove, arg: true },
};

const [, , sub, ...rest] = process.argv;
const cmd = sub ? COMMANDS[sub] : undefined;
if (!cmd) {
	usage();
	process.exit(sub ? 1 : 0);
}
if (cmd.arg && !rest[0]) {
	console.error(`tcc mcp: '${sub}' requires a server name`);
	usage();
	process.exit(1);
}
cmd.fn(rest[0]);
