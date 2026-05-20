// Shared MCP server catalog: every entry knows what env / binaries it needs and
// returns a ready-to-write mcp.json config block when `.config()` succeeds.
// Consumed by scripts/init.mjs (best-effort auto-detect) and scripts/mcp.mjs
// (interactive add/list/show).
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { which } from "./which.mjs";

function need(envVar) {
	if (!process.env[envVar]) throw new Error(`${envVar} not set in env`);
}

function needBin(bin, hint) {
	if (!which(bin)) throw new Error(`${bin} not on PATH${hint ? ` — ${hint}` : ""}`);
}

function ghAuthToken() {
	if (!which("gh")) return undefined;
	try {
		return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000 }).trim() || undefined;
	} catch {
		return undefined;
	}
}

export const CATALOG = {
	github: {
		summary: "GitHub MCP (issues, PRs, repos). Reads GITHUB_PERSONAL_ACCESS_TOKEN at spawn time.",
		requires: ["GITHUB_PERSONAL_ACCESS_TOKEN env var", "npx on PATH"],
		config: () => {
			needBin("npx");
			if (!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
				const hint = ghAuthToken() ? "  hint: export GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token)\n  (add it to your shell rc to persist; tcc reads env at spawn time, not from mcp.json)" : "  hint: create a PAT at https://github.com/settings/tokens, then export it";
				throw new Error(`GITHUB_PERSONAL_ACCESS_TOKEN not set in env\n${hint}`);
			}
			return { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_PERSONAL_ACCESS_TOKEN" } };
		},
	},
	filesystem: {
		summary: "Local filesystem MCP rooted at $HOME (read/list/stat).",
		requires: ["npx on PATH"],
		config: () => {
			needBin("npx", "install Node.js");
			return { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", homedir()] };
		},
	},
	notion: {
		summary: "Notion MCP (pages, databases). Needs NOTION_TOKEN.",
		requires: ["NOTION_TOKEN env var", "npx on PATH"],
		config: () => {
			need("NOTION_TOKEN");
			needBin("npx");
			return {
				command: "npx",
				args: ["-y", "@notionhq/notion-mcp-server"],
				env: { OPENAPI_MCP_HEADERS: `{"Authorization":"Bearer $NOTION_TOKEN","Notion-Version":"2022-06-28"}` },
			};
		},
	},
	jira: {
		summary: "Atlassian (Jira + Confluence) MCP. Needs ATLASSIAN_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN.",
		requires: ["uvx on PATH", "ATLASSIAN_URL + ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN env"],
		config: () => {
			needBin("uvx", "install via `brew install uv`");
			need("ATLASSIAN_URL");
			need("ATLASSIAN_EMAIL");
			need("ATLASSIAN_API_TOKEN");
			return {
				command: "uvx",
				args: ["mcp-atlassian"],
				env: { JIRA_URL: "$ATLASSIAN_URL", JIRA_USERNAME: "$ATLASSIAN_EMAIL", JIRA_API_TOKEN: "$ATLASSIAN_API_TOKEN" },
			};
		},
	},
	linear: {
		summary: "Linear issues MCP. Needs LINEAR_API_KEY.",
		requires: ["LINEAR_API_KEY env var", "npx on PATH"],
		config: () => {
			need("LINEAR_API_KEY");
			needBin("npx");
			return { command: "npx", args: ["-y", "@modelcontextprotocol/server-linear"], env: { LINEAR_API_KEY: "$LINEAR_API_KEY" } };
		},
	},
	slack: {
		summary: "Slack MCP. Needs SLACK_BOT_TOKEN and SLACK_TEAM_ID.",
		requires: ["SLACK_BOT_TOKEN + SLACK_TEAM_ID env vars"],
		config: () => {
			need("SLACK_BOT_TOKEN");
			need("SLACK_TEAM_ID");
			return { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "$SLACK_BOT_TOKEN", SLACK_TEAM_ID: "$SLACK_TEAM_ID" } };
		},
	},
	sentry: {
		summary: "Sentry MCP. Needs SENTRY_AUTH_TOKEN.",
		requires: ["SENTRY_AUTH_TOKEN env var"],
		config: () => {
			need("SENTRY_AUTH_TOKEN");
			return { command: "npx", args: ["-y", "@modelcontextprotocol/server-sentry"], env: { SENTRY_AUTH_TOKEN: "$SENTRY_AUTH_TOKEN" } };
		},
	},
};

/** Build configs for catalog entries whose prerequisites are currently met.
 *  Returns { servers: { name: config }, detections: [[name, status], ...] }. */
export function buildAvailable(names = Object.keys(CATALOG)) {
	const servers = {};
	const detections = [];
	for (const name of names) {
		const entry = CATALOG[name];
		if (!entry) {
			detections.push([name, "unknown (not in catalog)"]);
			continue;
		}
		try {
			servers[name] = entry.config();
			detections.push([name, "ok"]);
		} catch (err) {
			detections.push([name, `skipped (${err.message})`]);
		}
	}
	return { servers, detections };
}
