import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askExtension from "./ask.ts";
import authStatsExtension from "./auth-stats.ts";
import bedrockExtension from "./bedrock.ts";
import budgetsExtension from "./budgets.ts";
import checkpointsExtension from "./checkpoints.ts";
import cliToolsExtension from "./cli-tools.ts";
import compactThenExtension from "./compact-then.ts";
import contextExtension from "./context.ts";
import debugExtension from "./debug.ts";
import editRecoveryExtension from "./edit-recovery.ts";
import egressExtension from "./egress.ts";
import exitExtension from "./exit.ts";
import freshnessExtension from "./freshness.ts";
import gitToolsExtension from "./git-tools.ts";
import helpExtension from "./help.ts";
import hooksExtension from "./hooks.ts";
import loginExtension from "./login.ts";
import measureTwiceExtension from "./measure-twice.ts";
import memoryExtension from "./memory.ts";
import notifyExtension from "./notify.ts";
import pluginsExtension from "./plugins.ts";
import mcpExtension from "./mcp.ts";
import onboardExtension from "./onboard.ts";
import permissionsExtension from "./permissions.ts";
import predictiveContextExtension from "./predictive-context.ts";
import reloadExtension from "./reload.ts";
import repoStatusExtension from "./repo-status.ts";
import researchExtension from "./research.ts";
import retroExtension from "./retro.ts";
import screenshotExtension from "./screenshot.ts";
import shareExtension from "./share.ts";
import watchExtension from "./watch.ts";
import mcpAdminExtension from "./mcp-admin.ts";
import oneLastPassExtension from "./one-last-pass.ts";
import permissionAdminExtension from "./permission-admin.ts";
import pluginAdminExtension from "./plugin-admin.ts";
import subagentsExtension from "./subagents.ts";
import themeExtension from "./theme.ts";
import todoExtension from "./todo.ts";
import usageExtension from "./usage.ts";

// Detect non-interactive (--print / -p) at module load. Pi has run-mode info on
// the ExtensionContext at session_start (ctx.hasUI), but extension registration
// happens before any session, so we read argv directly. This is safe: pi parses
// the same flags from the same argv we're inspecting.
const IS_PRINT_MODE = process.argv.includes("--print") || process.argv.includes("-p");

export default async function tcc(pi: ExtensionAPI): Promise<void> {
	// Always-on: provider, tools, permission gating, memory, hooks, budgets, debug.
	// These either feed the agent loop directly or guard against destructive actions
	// — print mode (used by hooks, scripting, /tcc:since) needs them just as much.
	bedrockExtension(pi);
	debugExtension(pi);
	cliToolsExtension(pi);
	gitToolsExtension(pi);
	screenshotExtension(pi);
	usageExtension(pi);
	budgetsExtension(pi);
	memoryExtension(pi);
	predictiveContextExtension(pi);
	checkpointsExtension(pi);
	permissionsExtension(pi);
	egressExtension(pi);
	measureTwiceExtension(pi);
	subagentsExtension(pi);
	hooksExtension(pi);
	loginExtension(pi);
	researchExtension(pi);
	freshnessExtension(pi);
	editRecoveryExtension(pi);

	// Slash-command-only or UI-decoration extensions. Print mode never paints a
	// UI and never reads a slash command, so registering these is wasted work.
	if (!IS_PRINT_MODE) {
		themeExtension(pi);
		todoExtension(pi);
		repoStatusExtension(pi);
		onboardExtension(pi);
		permissionAdminExtension(pi);
		oneLastPassExtension(pi);
		helpExtension(pi);
		exitExtension(pi);
		compactThenExtension(pi);
		contextExtension(pi);
		reloadExtension(pi);
		notifyExtension(pi);
		authStatsExtension(pi);
		retroExtension(pi);
		shareExtension(pi);
		watchExtension(pi);
		askExtension(pi);
	}

	const { mcpServers } = await pluginsExtension(pi);
	if (!IS_PRINT_MODE) pluginAdminExtension(pi);
	await mcpExtension(pi, mcpServers);
	if (!IS_PRINT_MODE) mcpAdminExtension(pi);
}
