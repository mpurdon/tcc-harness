import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { playNotification } from "./notify.ts";
import { loadTccConfig } from "./util.ts";

type Action = "block" | "confirm" | "warn";

interface Rule {
	name: string;
	tool?: string;
	pattern: string;
	action: Action;
	message?: string;
}

interface PermissionsFile {
	rules?: Rule[];
	defaults?: boolean;
	/** Names of built-in default rules to skip while keeping the rest active.
	 *  Use this when you want most defaults but not, say, prefer-ls-tool. */
	disabledDefaults?: string[];
}

export function defaultRuleSummaries(): { name: string; action: Action; message: string }[] {
	return DEFAULT_RULES.map((r) => ({ name: r.name, action: r.action, message: r.message ?? "" }));
}

type RuleSource = "default" | "global" | "project";

interface CompiledRule extends Rule {
	tool: string;
	matcher: RegExp;
	source: RuleSource;
}

const DEFAULT_RULES: Rule[] = [
	{ name: "rm-rf-dangerous", tool: "bash", pattern: "\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\\s+(/+|/etc|/usr|/var|/bin|/sbin|/opt|/System|\\$HOME|~/?\\s*$|~/(?!\\.)|/Users/[^/]+/?\\s*$)", action: "block", message: "Refusing rm -rf against root/home/system path. If you really mean it, run it yourself outside tcc." },
	{ name: "git-force-push-protected", tool: "bash", pattern: "\\bgit\\s+push\\b.*--force(?:-with-lease)?\\b.*\\b(?:main|master|prod|production|release)\\b", action: "block", message: "Force-pushing to main/master/prod is blocked. Push to a branch and open a PR." },
	{ name: "git-force-push", tool: "bash", pattern: "\\bgit\\s+push\\b.*--force(?:-with-lease)?\\b", action: "confirm", message: "Force push detected. Confirm?" },
	{ name: "terraform-destroy", tool: "bash", pattern: "\\bterraform\\s+(?:.*\\s+)?destroy\\b", action: "confirm", message: "terraform destroy will tear down infrastructure. Confirm?" },
	{ name: "kubectl-delete", tool: "bash", pattern: "\\bkubectl\\s+delete\\b(?!.*\\bdry-run\\b)", action: "confirm", message: "kubectl delete (no --dry-run). Confirm?" },
	{ name: "aws-iam-mutate", tool: "bash", pattern: "\\baws\\s+iam\\s+(?:create|delete|put|attach|detach|update|remove|add)\\b", action: "confirm", message: "aws iam mutation. Confirm?" },
	{ name: "drop-database", tool: "bash", pattern: "\\b(?:DROP|TRUNCATE)\\s+(?:DATABASE|TABLE|SCHEMA)\\b", action: "confirm", message: "DROP/TRUNCATE statement detected. Confirm?" },
	{ name: "curl-pipe-shell", tool: "bash", pattern: "\\bcurl\\b[^|]*\\|\\s*(?:sudo\\s+)?(?:ba|z|f)?sh\\b", action: "confirm", message: "curl | sh is a remote code execution vector. Confirm?" },
	// Prefer pi-native tools over re-rolled CLI invocations. Leading-position only so
	// pipe-filter usages (`ps aux | grep foo`) aren't flagged.
	{ name: "prefer-search-text", tool: "bash", pattern: "^\\s*grep\\b", action: "warn", message: "Prefer the `search_text` tool (ripgrep, respects .gitignore) over leading `grep`." },
	{ name: "prefer-find-files", tool: "bash", pattern: "^\\s*find\\b", action: "warn", message: "Prefer the `find_files` tool (fd, respects .gitignore) over leading `find`." },
	{ name: "prefer-ls-tool", tool: "bash", pattern: "^\\s*ls\\b", action: "warn", message: "Prefer the `ls` tool over leading `ls` in bash." },
];

function compile(rule: Rule, source: RuleSource): CompiledRule | null {
	try {
		return { ...rule, tool: rule.tool ?? "bash", matcher: new RegExp(rule.pattern), source };
	} catch (err) {
		console.error(`[tcc permissions] invalid pattern in rule '${rule.name}': ${(err as Error).message}`);
		return null;
	}
}

function loadAndCompile(cwd: string): Map<string, CompiledRule[]> {
	const { global, project } = loadTccConfig<PermissionsFile>("permissions.json", cwd, "permissions");
	const defaultsEnabled = (global?.defaults ?? true) && (project?.defaults ?? true);
	const skipped = new Set([...(global?.disabledDefaults ?? []), ...(project?.disabledDefaults ?? [])]);
	const ordered: { rule: Rule; source: RuleSource }[] = [
		...(project?.rules ?? []).map((rule) => ({ rule, source: "project" as const })),
		...(global?.rules ?? []).map((rule) => ({ rule, source: "global" as const })),
		...(defaultsEnabled ? DEFAULT_RULES.filter((rule) => !skipped.has(rule.name)).map((rule) => ({ rule, source: "default" as const })) : []),
	];

	const buckets = new Map<string, CompiledRule[]>();
	for (const { rule, source } of ordered) {
		const compiled = compile(rule, source);
		if (!compiled) continue;
		const list = buckets.get(compiled.tool) ?? [];
		list.push(compiled);
		buckets.set(compiled.tool, list);
	}
	return buckets;
}

function targetText(event: ToolCallEvent): string {
	if (isToolCallEventType("bash", event)) return event.input.command;
	return JSON.stringify(event.input);
}

export default function permissionsExtension(pi: ExtensionAPI): void {
	const rulesByCwd = new Map<string, Map<string, CompiledRule[]>>();

	const getRules = (cwd: string): Map<string, CompiledRule[]> => {
		let buckets = rulesByCwd.get(cwd);
		if (!buckets) {
			buckets = loadAndCompile(cwd);
			rulesByCwd.set(cwd, buckets);
		}
		return buckets;
	};

	pi.on("session_start", (_event, ctx) => {
		// Force a fresh read on session start so edits land without a process restart.
		rulesByCwd.delete(ctx.cwd);
	});

	pi.on("tool_call", async (event, ctx) => {
		const bucket = getRules(ctx.cwd).get(event.toolName);
		if (!bucket || bucket.length === 0) return;

		const text = targetText(event);
		for (const rule of bucket) {
			if (!rule.matcher.test(text)) continue;
			const why = rule.message ?? `Blocked by rule '${rule.name}'.`;

			if (rule.action === "warn") {
				console.error(`[tcc permissions] warn '${rule.name}' (${rule.source}) on ${event.toolName}: ${why}`);
				continue;
			}
			if (rule.action === "block") {
				return { block: true, reason: `[${rule.name}] ${why}` };
			}
			// confirm
			if (!ctx.hasUI) {
				return { block: true, reason: `[${rule.name}] ${why} (no UI for interactive confirm — rerun in interactive tcc to approve)` };
			}
			// Fire the desktop notification BEFORE awaiting the confirm dialog —
			// that's the moment the user needs to come back to the terminal.
			playNotification("permission", `${rule.name}: ${event.toolName}`);
			const ok = await ctx.ui.confirm(`tcc: confirm ${rule.name}`, `${why}\n\nCommand: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
			if (!ok) return { block: true, reason: `[${rule.name}] declined by user` };
			return;
		}
	});
}
