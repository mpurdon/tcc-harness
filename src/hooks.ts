import { isBashToolResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { loadTccConfig, runProcess } from "./util.ts";

type EventKind = "PostBashCommand" | "PostToolUse" | "Stop";
type ActionKind = "slashCommand" | "prompt" | "shell";
type RuleSource = "global" | "project";

interface HookAction {
	type: ActionKind;
	command: string;
	timeoutMs?: number;
}

interface HookRule {
	event: EventKind;
	/** Regex against the bash command (PostBashCommand) or tool name (PostToolUse). Omit for Stop. */
	match?: string;
	/** When true (default), skip the rule if the originating tool reported isError. */
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

function ruleMatches(rule: CompiledRule, event: ToolResultEvent): boolean {
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

async function runAction(pi: ExtensionAPI, ctx: ExtensionContext, action: HookAction): Promise<void> {
	switch (action.type) {
		case "slashCommand": {
			const cmd = action.command.startsWith("/") ? action.command : `/${action.command}`;
			pi.sendUserMessage(cmd, { deliverAs: "followUp" });
			return;
		}
		case "prompt":
			pi.sendUserMessage(action.command, { deliverAs: "followUp" });
			return;
		case "shell": {
			const result = await runProcess({
				cmd: "/bin/sh",
				args: ["-c", action.command],
				cwd: ctx.cwd,
				env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.cwd },
				timeoutMs: action.timeoutMs ?? 30_000,
				inheritStdio: true,
			});
			if (result.reason !== "exit" || (result.exitCode !== 0 && result.exitCode !== null)) {
				console.error(`[tcc hooks] shell '${action.command}' ${result.reason} (exit ${result.exitCode})`);
			}
			return;
		}
	}
}

async function runActions(pi: ExtensionAPI, ctx: ExtensionContext, rule: CompiledRule): Promise<void> {
	for (const action of rule.actions) await runAction(pi, ctx, action);
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

	pi.on("session_start", (_event, ctx) => {
		rulesByCwd.delete(ctx.cwd);
	});

	pi.on("tool_result", async (event, ctx) => {
		for (const rule of getRules(ctx.cwd)) {
			if (rule.event !== "PostBashCommand" && rule.event !== "PostToolUse") continue;
			if (!ruleMatches(rule, event)) continue;
			await runActions(pi, ctx, rule);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		for (const rule of getRules(ctx.cwd)) {
			if (rule.event !== "Stop") continue;
			await runActions(pi, ctx, rule);
		}
	});
}
