#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { buildAvailable } from "./lib/mcp-catalog.mjs";
import { which } from "./lib/which.mjs";

const HOME = homedir();
const TCC_DIR = join(HOME, ".tcc");
const CONFIG_PATH = join(TCC_DIR, "config.json");
const MCP_PATH = join(TCC_DIR, "mcp.json");

const DEFAULT_CONFIG = {
	// Marketplaces are opt-in. The interactive section below adds entries based on user choice.
	marketplaces: [],
	enabledPlugins: {},
	mcpServers: {},
};

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJson(path, data) {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

async function prompt(rl, question, defaultValue) {
	const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
	const answer = (await rl.question(`${question}${suffix}: `)).trim();
	return answer || defaultValue || "";
}

async function confirm(rl, question, defaultYes = true) {
	const ans = await prompt(rl, `${question} (${defaultYes ? "Y/n" : "y/N"})`, defaultYes ? "y" : "n");
	return /^y/i.test(ans);
}

// Known marketplaces offered during init. Add to this list if you publish your own.
// Private repos require the user to be authenticated via `gh auth login`.
const KNOWN_MARKETPLACES = [
	{
		key: "trajector",
		label: "Trajector internal (team-and-tech/agentic-agents + trajector-claude-plugins, requires gh access to private repos)",
		entries: [
			{ name: "agentic-agents", repo: "team-and-tech/agentic-agents" },
			{ name: "trajector-claude-plugins", repo: "team-and-tech/trajector-claude-plugins" },
		],
	},
];

async function pickMarketplaces(rl) {
	console.log("\nPlugin marketplaces (opt-in — defaults to none):");
	const selected = [];
	for (const mp of KNOWN_MARKETPLACES) {
		if (await confirm(rl, `  enable ${mp.label}?`, false)) {
			selected.push(...mp.entries);
		}
	}
	while (await confirm(rl, "  add a custom marketplace?", false)) {
		const repo = await prompt(rl, "    owner/repo");
		if (!repo || !repo.includes("/")) {
			console.log("    skipped — expected owner/repo format");
			continue;
		}
		const defaultName = repo.split("/").pop();
		const name = await prompt(rl, "    short name (used in plugin IDs)", defaultName);
		selected.push({ name, repo });
	}
	return selected;
}

function ssoCheck() {
	if (!which("aws")) return { ok: false, reason: "aws CLI not installed" };
	const profile = "claude-code-bedrock";
	try {
		execFileSync("aws", ["sts", "get-caller-identity", "--profile", profile], { stdio: ["ignore", "ignore", "ignore"], timeout: 5_000 });
		return { ok: true };
	} catch {
		return { ok: false, reason: `run:  aws sso login --profile ${profile}` };
	}
}

async function main() {
	console.log("tcc init — bootstrapping ~/.tcc/\n");
	mkdirSync(TCC_DIR, { recursive: true });

	const existingConfig = readJson(CONFIG_PATH);
	const existingMcp = readJson(MCP_PATH);

	if (existingConfig) {
		console.log(`  config.json: present (${CONFIG_PATH}) — leaving alone`);
	} else {
		writeJson(CONFIG_PATH, DEFAULT_CONFIG);
		console.log(`  config.json: wrote defaults → ${CONFIG_PATH}`);
	}

	const { servers, detections } = buildAvailable(["github", "filesystem", "notion", "jira"]);
	console.log("\nMCP server detection:");
	for (const [name, status] of detections) console.log(`  ${name.padEnd(12)} ${status}`);

	if (existingMcp) {
		console.log(`\n  mcp.json: present (${MCP_PATH}) — leaving alone`);
	} else if (Object.keys(servers).length === 0) {
		console.log(`\n  mcp.json: no servers to wire — skipped`);
	} else {
		writeJson(MCP_PATH, { mcpServers: servers });
		console.log(`\n  mcp.json: wrote ${Object.keys(servers).length} server(s) → ${MCP_PATH}`);
	}

	const sso = ssoCheck();
	console.log(`\nAWS SSO (Bedrock): ${sso.ok ? "ok" : `not ready — ${sso.reason}`}`);

	if (process.stdout.isTTY && process.stdin.isTTY) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			if (!existingConfig) {
				const selected = await pickMarketplaces(rl);
				if (selected.length > 0) {
					const cfg = readJson(CONFIG_PATH) ?? DEFAULT_CONFIG;
					cfg.marketplaces = selected;
					writeJson(CONFIG_PATH, cfg);
					console.log(`  config.json: wrote ${selected.length} marketplace(s) → ${CONFIG_PATH}`);
				}
			}
			const theme = await prompt(rl, "\nDefault theme (tokyo-night | catppuccin-mocha | gruvbox-dark | dark | light)", "tokyo-night");
			const shellRc = process.env.SHELL?.includes("zsh") ? `${HOME}/.zshrc` : `${HOME}/.bashrc`;
			if (await confirm(rl, `Append 'export TCC_DEFAULT_THEME=${theme}' to ${shellRc}?`)) {
				try {
					const existing = existsSync(shellRc) ? readFileSync(shellRc, "utf8") : "";
					if (existing.includes("TCC_DEFAULT_THEME=")) {
						console.log(`  ${shellRc}: TCC_DEFAULT_THEME already set — leaving alone`);
					} else {
						const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
						const tmp = `${shellRc}.tmp-${process.pid}-${Date.now()}`;
						writeFileSync(tmp, `${existing}${prefix}export TCC_DEFAULT_THEME=${theme}\n`, "utf8");
						renameSync(tmp, shellRc);
						console.log(`  ${shellRc}: appended`);
					}
				} catch (err) {
					console.error(`  ${shellRc}: failed to write — ${err.message}`);
				}
			}
		} finally {
			rl.close();
		}
	}

	console.log("\nNext:");
	console.log("  tcc                  # start a session");
	console.log("  tcc --print '…'       # one-shot");
	console.log("  tcc mcp catalog      # add more MCP servers");
	if (!sso.ok) console.log(`  aws sso login --profile claude-code-bedrock`);
}

main().catch((err) => {
	console.error("tcc init failed:", err.message);
	process.exit(1);
});
