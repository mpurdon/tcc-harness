import { isBashToolResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { loadTccConfig, runProcess } from "./util.ts";

// Hook events, named to match Claude Code's so a CC hooks.json drops in mostly
// unchanged. Each maps to a pi lifecycle event (see the handlers at the bottom).
type EventKind =
	| "SessionStart" // session_start
	| "SessionEnd" // session_shutdown
	| "UserPromptSubmit" // input (interactive/rpc only)
	| "PreToolUse" // tool_call — shell actions can block the call
	| "PostToolUse" // tool_result
	| "PostBashCommand" // tool_result, bash only
	| "PreCompact" // session_before_compact
	| "PostCompact" // session_compact
	| "Stop"; // agent_end
type ActionKind = "slashCommand" | "prompt" | "shell";
type RuleSource = "global" | "project";

interface HookAction {
	type: ActionKind;
	command: string;
	timeoutMs?: number;
}

interface HookRule {
	event: EventKind;
	/** Regex against the bash command (PostBashCommand), the tool name (Pre/PostToolUse),
	 *  or the prompt text (UserPromptSubmit). Omit for session/compact/Stop events. */
	match?: string;
	/** When true (default), skip the rule if the originating tool reported isError. PostToolUse/PostBashCommand only. */
	onlyIfSuccess?: boolean;
	actions: HookAction[];
}

interface HooksFile {
	hooks?: HookRule[];
}

interface CompiledRule extends HookRule {
	matcher?: RegExp;
	source: RuleSource;
}

interface ActionOutcome {
	/** PreToolUse only: a captured shell action exited non-zero → block the tool call. */
	block?: boolean;
	reason?: string;
}

function compileRules(rules: HookRule[] | undefined, source: RuleSource): CompiledRule[] {
	if (!rules) return [];
	const out: CompiledRule[] = [];
	for (const rule of rules) {
		if (rule.match) {
			try {
				out.push({ ...rule, matcher: new RegExp(rule.match), source });
				continue;
			} catch (err) {
				console.error(`[tcc hooks] invalid pattern '${rule.match}' in ${source}: ${(err as Error).message}`);
				continue;
			}
		}
		out.push({ ...rule, source });
	}
	return out;
}

function loadRules(cwd: string): CompiledRule[] {
	const { global, project } = loadTccConfig<HooksFile>("hooks.json", cwd, "hooks");
	return [...compileRules(global?.hooks, "global"), ...compileRules(project?.hooks, "project")];
}

function postMatches(rule: CompiledRule, event: ToolResultEvent): boolean {
	if (rule.onlyIfSuccess !== false && event.isError) return false;
	if (rule.event === "PostBashCommand") {
		if (!isBashToolResult(event)) return false;
		const cmd = (event.input as { command?: string }).command ?? "";
		return rule.matcher ? rule.matcher.test(cmd) : true;
	}
	if (rule.event === "PostToolUse") {
		return rule.matcher ? rule.matcher.test(event.toolName) : true;
	}
	return false;
}

// `capture` is set for blocking events (PreToolUse): the shell action runs with
// its output piped (not inherited) so a non-zero exit can be turned into a block
// reason the agent sees. For every other event shell output streams to the TUI.
async function runAction(pi: ExtensionAPI, ctx: ExtensionContext, action: HookAction, capture: boolean): Promise<ActionOutcome> {
	switch (action.type) {
		case "slashCommand": {
			const cmd = action.command.startsWith("/") ? action.command : `/${action.command}`;
			pi.sendUserMessage(cmd, { deliverAs: "followUp" });
			return {};
		}
		case "prompt":
			pi.sendUserMessage(action.command, { deliverAs: "followUp" });
			return {};
		case "shell": {
			const result = await runProcess({
				cmd: "/bin/sh",
				args: ["-c", action.command],
				cwd: ctx.cwd,
				env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.cwd },
				timeoutMs: action.timeoutMs ?? 30_000,
				inheritStdio: !capture,
			});
			const failed = result.reason !== "exit" || (result.exitCode !== 0 && result.exitCode !== null);
			if (!failed) return {};
			if (!capture) {
				console.error(`[tcc hooks] shell '${action.command}' ${result.reason} (exit ${result.exitCode})`);
				return {};
			}
			const detail = (result.stderr || result.stdout || "").trim().slice(0, 500);
			return { block: true, reason: detail || `shell gate exited ${result.exitCode}` };
		}
	}
}

async function runActions(pi: ExtensionAPI, ctx: ExtensionContext, rule: CompiledRule, capture: boolean): Promise<ActionOutcome> {
	for (const action of rule.actions) {
		const out = await runAction(pi, ctx, action, capture);
		if (out.block) return out;
	}
	return {};
}

export default function hooksExtension(pi: ExtensionAPI): void {
	const rulesByCwd = new Map<string, CompiledRule[]>();
	const getRules = (cwd: string): CompiledRule[] => {
		let rules = rulesByCwd.get(cwd);
		if (!rules) {
			rules = loadRules(cwd);
			rulesByCwd.set(cwd, rules);
		}
		return rules;
	};
	const fireFor = async (event: EventKind, ctx: ExtensionContext): Promise<void> => {
		for (const rule of getRules(ctx.cwd)) {
			if (rule.event !== event) continue;
			await runActions(pi, ctx, rule, false);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		rulesByCwd.delete(ctx.cwd); // reload on each new session so edits to hooks.json take effect
		await fireFor("SessionStart", ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await fireFor("SessionEnd", ctx);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		await fireFor("PreCompact", ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		await fireFor("PostCompact", ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return; // ignore hook-injected followups — avoids loops
		for (const rule of getRules(ctx.cwd)) {
			if (rule.event !== "UserPromptSubmit") continue;
			if (rule.matcher && !rule.matcher.test(event.text)) continue;
			await runActions(pi, ctx, rule, false);
		}
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		for (const rule of getRules(ctx.cwd)) {
			if (rule.event !== "PreToolUse") continue;
			if (rule.matcher && !rule.matcher.test(event.toolName)) continue;
			const out = await runActions(pi, ctx, rule, true);
			if (out.block) return { block: true, reason: `[hook:${rule.source}] ${out.reason}` };
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		for (const rule of getRules(ctx.cwd)) {
			if (rule.event !== "PostBashCommand" && rule.event !== "PostToolUse") continue;
			if (!postMatches(rule, event)) continue;
			await runActions(pi, ctx, rule, false);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		await fireFor("Stop", ctx);
	});
}
