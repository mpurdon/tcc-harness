#!/usr/bin/env node
// tcc doctor — environment health check for first-run and ongoing troubleshooting.
//
// Verifies every prerequisite tcc relies on: node, pi, aws CLI + SSO, the shared
// settings file with Bedrock inference-profile ARNs, ~/.tcc/ layout, optional CLI
// tools (rg/fd/lsd/gh), and MCP server commands. With --deep, also makes a real
// Bedrock API call to verify reachability.
//
// Exit code: 0 if all checks pass or only warnings; 1 if any failure.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "./lib/which.mjs";

const DEEP = process.argv.includes("--deep");
const NO_COLOR = !process.stdout.isTTY || process.env.NO_COLOR;

const c = {
	green: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
	red: (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
	yellow: (s) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
	dim: (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
	bold: (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
};

const ICONS = { ok: c.green("✓"), warn: c.yellow("⚠"), fail: c.red("✗") };
const results = [];

function record(status, name, detail, fix) {
	results.push({ status, name, detail, fix });
}

function tryExec(cmd, args, opts = {}) {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, ...opts }).trim();
	} catch (err) {
		return { error: err };
	}
}

// ---------- checks ----------

function checkNode() {
	const v = process.versions.node;
	const major = Number.parseInt(v.split(".")[0], 10);
	if (major >= 20) return record("ok", "node", `v${v} at ${process.execPath}`);
	record("fail", "node", `v${v} too old — pi requires >= 20`, "install Node 20+ via nvm or your system package manager");
}

function checkPi() {
	const pi = which("pi");
	if (!pi) return record("fail", "pi", "not on PATH", "npm install -g @earendil-works/pi-coding-agent");
	// pi writes --version to stderr in current builds; capture both streams and grep for a semver.
	const proc = spawnSync(pi, ["--version"], { encoding: "utf8", timeout: 10_000 });
	const combined = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
	const semver = combined.match(/\d+\.\d+\.\d+/)?.[0];
	if (semver) return record("ok", "pi", `${semver} at ${pi}`);
	record("warn", "pi", `installed at ${pi} but couldn't parse version output`, "try: pi --version manually");
}

function checkAwsCli() {
	const aws = which("aws");
	if (!aws) return record("fail", "aws cli", "not on PATH", "install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html");
	const v = tryExec(aws, ["--version"]);
	const versionStr = typeof v === "string" ? v.split(" ")[0] : "(version unknown)";
	record("ok", "aws cli", `${versionStr} at ${aws}`);
}

function loadSettings() {
	// Canonical location is ~/.tcc/bedrock.json; legacy ~/.claude/trajector-settings.json
	// is read as a fallback for users migrating from the pre-public-rename era.
	const candidates = [
		join(homedir(), ".tcc", "bedrock.json"),
		join(homedir(), ".claude", "trajector-settings.json"),
	];
	let firstErr;
	for (const path of candidates) {
		try {
			const raw = readFileSync(path, "utf8");
			return { path, json: JSON.parse(raw) };
		} catch (err) {
			firstErr ??= err;
		}
	}
	return { path: candidates[0], error: firstErr };
}

function checkSettingsFile(settings) {
	if (settings.error) {
		return record("fail", "settings file", `missing or unreadable at ${settings.path}`, "run `tcc init` to write a template, then follow https://github.com/mpurdon/tcc-harness#first-run to obtain Bedrock inference-profile ARNs.");
	}
	const env = settings.json?.env ?? {};
	const required = ["AWS_PROFILE", "AWS_REGION", "ANTHROPIC_DEFAULT_SONNET_MODEL"];
	const missing = required.filter((k) => !env[k]);
	if (missing.length > 0) {
		return record("fail", "settings file", `${settings.path} missing env keys: ${missing.join(", ")}`, "populate the env block with the required keys — see https://github.com/mpurdon/tcc-harness#first-run");
	}
	// Catches the "ran tcc init but never filled in real ARNs" state.
	const arnVals = [env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL];
	const stillTemplated = arnVals.some((v) => typeof v === "string" && /ACCOUNT_ID|SONNET_PROFILE_ID|OPUS_PROFILE_ID|HAIKU_PROFILE_ID/.test(v));
	if (stillTemplated) {
		return record("fail", "settings file", `${settings.path} still contains template placeholders — ARNs not filled in`, "edit ~/.tcc/bedrock.json and replace the placeholder ANTHROPIC_DEFAULT_*_MODEL values with real ARNs — see https://github.com/mpurdon/tcc-harness#first-run");
	}
	const arnCount = arnVals.filter(Boolean).length;
	if (arnCount < 3) {
		return record("warn", "settings file", `${settings.path} ok but only ${arnCount}/3 Bedrock model ARNs set — model switching will be limited`, "add the remaining ANTHROPIC_DEFAULT_*_MODEL ARNs");
	}
	record("ok", "settings file", `${settings.path} (profile=${env.AWS_PROFILE}, region=${env.AWS_REGION})`);
}

function checkAwsSso(settings) {
	const profile = settings.json?.env?.AWS_PROFILE || "claude-code-bedrock";
	const r = tryExec("aws", ["sts", "get-caller-identity", "--profile", profile, "--output", "json"]);
	if (typeof r !== "string") {
		const msg = r.error?.stderr?.toString().trim().split("\n").pop() ?? r.error?.message ?? "unknown error";
		return record("fail", "aws sso session", `profile '${profile}' is not authenticated (${msg.slice(0, 100)})`, `tcc login ${profile}   # or: aws sso login --profile ${profile}`);
	}
	try {
		const parsed = JSON.parse(r);
		record("ok", "aws sso session", `profile '${profile}' valid (${parsed.Arn ?? parsed.Account})`);
	} catch {
		record("warn", "aws sso session", `profile '${profile}' returned unexpected output`, "rerun: aws sts get-caller-identity --profile " + profile);
	}
}

function checkBedrockReach(settings) {
	if (!DEEP) return; // skipped without --deep
	const profile = settings.json?.env?.AWS_PROFILE || "claude-code-bedrock";
	const region = settings.json?.env?.AWS_REGION || "us-east-2";
	const r = tryExec("aws", ["bedrock", "list-inference-profiles", "--profile", profile, "--region", region, "--max-results", "1", "--output", "json"]);
	if (typeof r !== "string") {
		const msg = r.error?.stderr?.toString().trim().split("\n").pop() ?? "unknown error";
		return record("fail", "bedrock reach", `list-inference-profiles failed (${msg.slice(0, 100)})`, "check IAM permissions for the SSO role + that Bedrock is enabled in the account");
	}
	record("ok", "bedrock reach", `${region}: list-inference-profiles ok`);
}

function checkTccHome() {
	const tcc = join(homedir(), ".tcc");
	try {
		const s = statSync(tcc);
		if (!s.isDirectory()) return record("fail", "~/.tcc/", `${tcc} exists but is not a directory`, "remove the offending file and run: tcc init");
		record("ok", "~/.tcc/", `${tcc} present`);
	} catch {
		record("warn", "~/.tcc/", `${tcc} missing — first run hasn't completed`, "tcc init");
	}
}

function checkCliTool(name, install) {
	if (which(name)) return record("ok", name, "on PATH");
	record("warn", name, "not installed (optional — tcc has fallbacks)", install);
}

function checkMcpServers() {
	const cfgPath = join(homedir(), ".tcc", "mcp.json");
	let cfg;
	try {
		cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
	} catch {
		return record("warn", "mcp servers", `${cfgPath} not present — no MCP servers configured`, "tcc mcp catalog   # to see what's available");
	}
	const servers = cfg.mcpServers ?? {};
	const names = Object.keys(servers);
	if (names.length === 0) return record("ok", "mcp servers", "none configured");
	const missing = [];
	for (const [name, def] of Object.entries(servers)) {
		const cmd = def.command;
		if (!cmd) continue;
		// npx is fine to assume; check absolute paths and bare binaries
		if (cmd.startsWith("/")) {
			try {
				statSync(cmd);
			} catch {
				missing.push(`${name} (command ${cmd} not found)`);
			}
		} else if (!which(cmd)) {
			missing.push(`${name} (command '${cmd}' not on PATH)`);
		}
	}
	if (missing.length > 0) {
		return record("warn", "mcp servers", `${names.length} configured; ${missing.length} have missing commands: ${missing.join("; ")}`, "fix the command path in ~/.tcc/mcp.json or install the missing tool");
	}
	record("ok", "mcp servers", `${names.length} configured (${names.join(", ")})`);
}

function checkSecrets() {
	const path = join(homedir(), ".tcc", "secrets.json");
	let st;
	try {
		st = statSync(path);
	} catch {
		return record("ok", "secrets.json", `none (optional — add ${path} with {"TAVILY_API_KEY": "tvly-…"} to enable richer research)`);
	}
	let body;
	try {
		body = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		return record("fail", "secrets.json", `${path} unparseable: ${e.message}`, "fix or delete the file");
	}
	const keys = Object.keys(body);
	const mode = (st.mode & 0o777).toString(8);
	if (mode !== "600" && mode !== "400") {
		return record("warn", "secrets.json", `${keys.length} keys, mode ${mode} (recommend 600)`, `chmod 600 ${path}`);
	}
	record("ok", "secrets.json", `${keys.length} keys, mode ${mode}`);
}

function checkTccOnPath() {
	const tcc = which("tcc");
	if (!tcc) return record("warn", "tcc on PATH", "not resolvable as bare 'tcc' — running via absolute path", "./install.sh   # to symlink into ~/bin or ~/.local/bin");
	record("ok", "tcc on PATH", tcc);
}

// ---------- run ----------

console.log(c.bold("tcc doctor"));
console.log(c.dim(`Reading prerequisites, optional tooling, and config. ${DEEP ? "Deep mode: making a real Bedrock API call." : "(pass --deep to also probe Bedrock.)"}`));
console.log(c.dim("─".repeat(60)));

checkNode();
checkPi();
checkAwsCli();
const settings = loadSettings();
checkSettingsFile(settings);
if (!settings.error) {
	checkAwsSso(settings);
	checkBedrockReach(settings);
}
checkTccHome();
checkSecrets();
checkTccOnPath();
checkCliTool("rg", "brew install ripgrep   # or apt install ripgrep");
checkCliTool("fd", "brew install fd        # or apt install fd-find");
checkCliTool("lsd", "brew install lsd       # or cargo install lsd");
checkCliTool("gh", "brew install gh        # or see https://cli.github.com");
checkMcpServers();

const nameWidth = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
	const icon = ICONS[r.status];
	console.log(`${icon} ${r.name.padEnd(nameWidth)}  ${r.detail}`);
	if (r.fix && r.status !== "ok") {
		console.log(`${" ".repeat(nameWidth + 4)}${c.dim("fix:")} ${c.dim(r.fix)}`);
	}
}

const failures = results.filter((r) => r.status === "fail").length;
const warnings = results.filter((r) => r.status === "warn").length;
const oks = results.filter((r) => r.status === "ok").length;
console.log(c.dim("─".repeat(60)));
console.log(`${failures > 0 ? c.red(`${failures} failure${failures === 1 ? "" : "s"}`) : "0 failures"}, ${warnings > 0 ? c.yellow(`${warnings} warning${warnings === 1 ? "" : "s"}`) : "0 warnings"}, ${c.green(`${oks} ok`)}`);

process.exit(failures > 0 ? 1 : 0);
