import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findGitRoot } from "./config.ts";
import { runProcess } from "./util.ts";

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

interface AgentFrontmatter {
	name?: string;
	description?: string;
	tools?: string | string[];
	model?: string;
	[key: string]: unknown;
}

function loadDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: AgentConfig[] = [];
	for (const file of entries) {
		if (!file.endsWith(".md")) continue;
		const filePath = join(dir, file);
		try {
			if (!statSync(filePath).isFile()) continue;
		} catch {
			continue;
		}
		let raw: string;
		try {
			raw = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		let parsed: { frontmatter: AgentFrontmatter; body: string };
		try {
			parsed = parseFrontmatter<AgentFrontmatter>(raw);
		} catch {
			continue;
		}
		const fm = parsed.frontmatter;
		if (!fm.name || !fm.description) continue;
		const tools = typeof fm.tools === "string" ? fm.tools.split(",").map((t) => t.trim()).filter(Boolean) : fm.tools;
		out.push({
			name: fm.name,
			description: fm.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: fm.model,
			systemPrompt: parsed.body.trim(),
			source,
			filePath,
		});
	}
	return out;
}

function discoverAgents(cwd: string): AgentConfig[] {
	const sources: { dir: string; source: AgentConfig["source"] }[] = [
		{ dir: join(homedir(), ".claude", "agents"), source: "user" },
		{ dir: join(homedir(), ".pi", "agent", "agents"), source: "user" },
	];
	const root = findGitRoot(cwd);
	if (root) {
		sources.push({ dir: join(root, ".claude", "agents"), source: "project" });
		sources.push({ dir: join(root, ".pi", "agents"), source: "project" });
	}
	const map = new Map<string, AgentConfig>();
	for (const { dir, source } of sources) {
		for (const agent of loadDir(dir, source)) {
			// Later sources (project) override earlier (user) on name collision.
			map.set(agent.name, agent);
		}
	}
	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function resolveModel(name: string | undefined): string | undefined {
	const aliases: Record<string, string | undefined> = {
		sonnet: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
		opus: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
		haiku: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
	};
	if (!name) return aliases.sonnet;
	if (name.startsWith("arn:")) return name;
	const lower = name.toLowerCase();
	for (const alias of Object.keys(aliases)) {
		if (lower.includes(alias)) return aliases[alias];
	}
	return aliases.sonnet;
}

const CC_TO_PI_TOOL: Record<string, string> = {
	read: "read",
	write: "write",
	edit: "edit",
	bash: "bash",
	grep: "grep",
	glob: "find",
	ls: "ls",
};

function mapTools(tools: string[] | undefined): string[] | undefined {
	if (!tools) return undefined;
	const mapped = new Set<string>();
	for (const t of tools) {
		const piName = CC_TO_PI_TOOL[t.toLowerCase()];
		if (piName) mapped.add(piName);
	}
	return mapped.size > 0 ? [...mapped] : undefined;
}

function describeAgents(agents: AgentConfig[]): string {
	if (agents.length === 0) {
		return "No subagents available. Drop a Claude-Code-style agent definition at ~/.claude/agents/<name>.md (frontmatter: name, description, model, tools) to add one.";
	}
	const lines = ["Available subagents (delegate one task at a time):"];
	for (const a of agents) {
		const desc = a.description.length > 200 ? `${a.description.slice(0, 200)}…` : a.description;
		const model = a.model ?? "sonnet";
		lines.push(`- **${a.name}** (${model}, ${a.source}) — ${desc.replace(/\n/g, " ")}`);
	}
	return lines.join("\n");
}

interface SpawnOptions {
	systemPrompt: string;
	task: string;
	model: string;
	tools: string[] | undefined;
	cwd: string;
	signal: AbortSignal | undefined;
	timeoutMs: number;
}

// Bedrock errors that won't get better with retries — broken/stale ARN, perms,
// expired creds, malformed model id. Throttling/ServiceUnavailable are NOT here
// because they're transient and pi already retries them.
const BEDROCK_FATAL_PATTERN = /(ResourceNotFoundException|AccessDeniedException|ValidationException|UnrecognizedClientException|InvalidIdentityToken|ExpiredTokenException|UnauthorizedOperation|InvalidSignatureException)/;

// Bedrock errors that DO get better with retries — throttling, transient 5xx,
// model-stream stutters. When we see one in stderr after a non-zero exit, we
// silently retry once with a brief delay before bubbling failure to the LLM.
const BEDROCK_TRANSIENT_PATTERN = /(ThrottlingException|TooManyRequestsException|ServiceUnavailableException|InternalServerException|ModelStreamErrorException|ModelTimeoutException)/;

const TRANSIENT_RETRY_DELAY_MS = 5_000;

// Session-level blacklist of ARNs that already failed-fast with a Bedrock fatal
// error. Subsequent delegate calls resolving to the same ARN short-circuit
// instead of repeating the wasted spawn. Cleared on session_start so a config
// fix takes effect immediately on the next session.
const brokenModels = new Map<string, string>();

interface SpawnPiResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	reason: string;
	/** How many spawn attempts produced this result (1 = no retry, 2 = one retry). */
	attempts: number;
}

async function spawnPiOnce(opts: SpawnOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null; reason: string }> {
	const args = [
		"--print",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-themes",
		"--provider",
		"amazon-bedrock",
		"--model",
		opts.model,
		"--system-prompt",
		opts.systemPrompt,
	];
	if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
	args.push(opts.task);

	const result = await runProcess({
		cmd: "pi",
		args,
		cwd: opts.cwd,
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
		fastFailStderrPattern: BEDROCK_FATAL_PATTERN,
	});
	return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, reason: result.reason };
}

function shouldRetry(result: { reason: string; exitCode: number | null; stderr: string }, signal: AbortSignal | undefined): boolean {
	if (signal?.aborted) return false;
	// Don't retry success, abort, fastFail (already known fatal), spawnError
	// (binary missing won't change), or timeout (already waited the full budget —
	// the orchestrator should decide whether to re-fire with more time).
	if (result.reason === "exit" && result.exitCode === 0) return false;
	if (result.reason === "abort" || result.reason === "fastFail" || result.reason === "spawnError" || result.reason === "timeout") return false;
	// Only retry exit-with-error if stderr looks like a transient Bedrock issue.
	return BEDROCK_TRANSIENT_PATTERN.test(result.stderr);
}

async function spawnPi(opts: SpawnOptions): Promise<SpawnPiResult> {
	const first = await spawnPiOnce(opts);
	if (!shouldRetry(first, opts.signal)) {
		return { ...first, attempts: 1 };
	}
	// Brief backoff so we're not racing the same throttle window. Abortable so
	// Ctrl-C during the sleep still cancels the whole call rather than waiting
	// out the full delay before discovering the abort.
	await new Promise<void>((res) => {
		const t = setTimeout(res, TRANSIENT_RETRY_DELAY_MS);
		opts.signal?.addEventListener("abort", () => {
			clearTimeout(t);
			res();
		}, { once: true });
	});
	if (opts.signal?.aborted) {
		return { ...first, attempts: 1 };
	}
	const second = await spawnPiOnce(opts);
	// Always report attempt count for transparency, even if the retry also fails.
	// stderr gets prefixed with the first-attempt error so the LLM (or a human
	// reading the result) can see what changed between attempts.
	const prefixedStderr = `[attempt 1 stderr]\n${first.stderr}\n\n[attempt 2 stderr]\n${second.stderr}`;
	return { ...second, attempts: 2, stderr: prefixedStderr };
}

function extractBedrockError(stderr: string): string | undefined {
	const match = stderr.match(BEDROCK_FATAL_PATTERN);
	if (!match) return undefined;
	// Grab the line containing the match plus the next line — usually has the AWS message.
	const lines = stderr.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(match[0])) {
			return lines.slice(i, Math.min(i + 2, lines.length)).join(" ").trim().slice(0, 300);
		}
	}
	return match[0];
}

function shortArn(arn: string): string {
	const slash = arn.lastIndexOf("/");
	return slash >= 0 ? arn.slice(slash + 1) : arn.slice(-24);
}

// Standardized failure trailer. The orchestrator (especially /tcc:one-last-pass)
// fans out many subagents and should treat any single failure as recoverable —
// otherwise one flaky reviewer halts the whole investigation. This trailer
// nudges the LLM toward "note it and proceed" instead of stopping to debug.
const PRESS_ON =
	"PRESS ON: this is one subagent failing, not the whole task. Note the gap " +
	"in your aggregation/summary, continue with the subagents that DID return, " +
	"and only retry/re-spawn this one if you have a specific hypothesis about " +
	"why it failed. Do NOT halt the broader investigation on a single failure.";

function describeFailure(label: string, reason: string, exitCode: number | null, seconds: string, attempts: number, stderr: string): string {
	const attemptsNote = attempts > 1 ? ` after ${attempts} attempts (auto-retried on transient Bedrock error)` : "";
	const stderrTail = stderr.length > 1500 ? stderr.slice(-1500) : stderr;
	return `${label} ended (${reason}, exit ${exitCode}) after ${seconds}s${attemptsNote}.\n\n${PRESS_ON}\n\nstderr (tail):\n${stderrTail}`;
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	const cache = new Map<string, AgentConfig[]>();
	const getAgents = (cwd: string): AgentConfig[] => {
		let agents = cache.get(cwd);
		if (!agents) {
			agents = discoverAgents(cwd);
			cache.set(cwd, agents);
		}
		return agents;
	};

	pi.on("session_start", (_event, ctx) => {
		cache.delete(ctx.cwd);
		brokenModels.clear();
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate to subagent",
		description:
			"Spawn a specialized subagent in an isolated context window to handle a focused task and report back. " +
			"Use this when a sub-problem has a clear name (e.g., 'security review', 'AWS architecture', 'plan an implementation') and a different agent would do it better. " +
			"Each subagent runs in its own pi process with its own system prompt and restricted tools; you get one final message back. " +
			"Call `list_subagents` first if you don't know what's available. Subagents do NOT see this conversation — give them complete standalone context in the task.",
		parameters: Type.Object({
			agent: Type.String({ description: "Subagent name (must match an available subagent)." }),
			task: Type.String({ description: "Standalone task description — include all context the subagent needs; it cannot see this conversation." }),
			timeoutMs: Type.Optional(Type.Number({ description: "Hard timeout in milliseconds (default 10 min)." })),
		}),
		renderCall: (args, _theme, context) => {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const taskLine = (args.task ?? "").split("\n")[0];
			const truncated = taskLine.length > 80 ? `${taskLine.slice(0, 80)}…` : taskLine;
			text.setText(`→ ${args.agent || "?"}: ${truncated || "(no task)"}`);
			return text;
		},
		async execute(_id, params, signal, _u, ctx) {
			const agents = getAgents(ctx.cwd);
			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				return {
					content: [{ type: "text", text: `unknown subagent '${params.agent}'. Available: ${agents.map((a) => a.name).join(", ") || "(none)"}` }],
					details: undefined,
					isError: true,
				};
			}
			const model = resolveModel(agent.model);
			if (!model) {
				return {
					content: [{ type: "text", text: "tcc: no Bedrock ARN resolvable from env — is the wrapper running?" }],
					details: undefined,
					isError: true,
				};
			}
			const cachedFailure = brokenModels.get(model);
			if (cachedFailure) {
				return {
					content: [{ type: "text", text: `subagent '${agent.name}' skipped: model ARN ${shortArn(model)} is blacklisted for this session — earlier call failed with: ${cachedFailure}. Use a different model alias (haiku/opus) or fix the ARN in ~/.tcc/bedrock.json and start a new session.` }],
					details: undefined,
					isError: true,
				};
			}
			const started = Date.now();
			ctx.ui.setStatus("tcc.delegate", `→ ${agent.name}`);
			try {
				const result = await spawnPi({
					systemPrompt: agent.systemPrompt,
					task: params.task,
					model,
					tools: mapTools(agent.tools),
					cwd: ctx.cwd,
					signal,
					timeoutMs: params.timeoutMs ?? 10 * 60_000,
				});
				const seconds = ((Date.now() - started) / 1000).toFixed(1);
				if (result.reason === "fastFail") {
					const errSummary = extractBedrockError(result.stderr) ?? "Bedrock fatal error";
					brokenModels.set(model, errSummary);
					ctx.ui.notify(`tcc: model ARN ${shortArn(model)} is broken — ${errSummary}. Blacklisted for this session; fix in ~/.tcc/bedrock.json.`, "error");
					return {
						content: [{ type: "text", text: `subagent '${agent.name}' failed fast (${seconds}s): ${errSummary}\n\nModel ARN: ${model}\nBlacklisted for this session. ${PRESS_ON}\n\nstderr (tail):\n${result.stderr.slice(-1500)}` }],
						details: undefined,
						isError: true,
					};
				}
				if (result.reason !== "exit" || (result.exitCode !== 0 && result.exitCode !== null)) {
					return {
						content: [{ type: "text", text: describeFailure(`subagent '${agent.name}'`, result.reason, result.exitCode, seconds, result.attempts, result.stderr) }],
						details: undefined,
						isError: true,
					};
				}
				const retryNote = result.attempts > 1 ? `  [retried 1x after transient Bedrock error]` : "";
				return {
					content: [{ type: "text", text: `[${agent.name} — ${seconds}s${retryNote}]\n\n${result.stdout || "(no output)"}` }],
					details: undefined,
				};
			} finally {
				ctx.ui.setStatus("tcc.delegate", undefined);
			}
		},
	});

	pi.registerTool({
		name: "delegate_inline",
		label: "Ad-hoc subagent",
		description:
			"Spawn an ad-hoc subagent with an inline system prompt — for review tasks that don't have a named subagent on disk (code reuse, code quality, efficiency, focused critique, etc). " +
			"Each call runs in its own pi process in an isolated context. Subagents do NOT see this conversation — give them complete standalone context in the task. " +
			"Prefer the named `delegate` tool when a specialized subagent exists; use this for one-off specializations or to run multiple reviewers in parallel within a single response.",
		parameters: Type.Object({
			systemPrompt: Type.String({ description: "Inline system prompt that defines the subagent's role, focus, and output format." }),
			task: Type.String({ description: "Standalone task description — include all context (diff, file contents, repo conventions) the subagent needs; it cannot see this conversation." }),
			model: Type.Optional(Type.String({ description: "Model alias (sonnet|opus|haiku) or full ARN. Defaults to sonnet." })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Restrict to a subset of tool names (e.g. ['read','grep','find']). Default: full toolset." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Hard timeout in milliseconds (default 10 min)." })),
		}),
		renderCall: (args, _theme, context) => {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const sysLabel = (args.systemPrompt ?? "").split("\n")[0].slice(0, 40);
			const taskLine = (args.task ?? "").split("\n")[0];
			const truncated = taskLine.length > 60 ? `${taskLine.slice(0, 60)}…` : taskLine;
			text.setText(`→ inline [${sysLabel || "?"}…]: ${truncated || "(no task)"}`);
			return text;
		},
		async execute(_id, params, signal, _u, ctx) {
			const model = resolveModel(params.model);
			if (!model) {
				return {
					content: [{ type: "text", text: "tcc: no Bedrock ARN resolvable from env — is the wrapper running?" }],
					details: undefined,
					isError: true,
				};
			}
			const cachedFailure = brokenModels.get(model);
			if (cachedFailure) {
				return {
					content: [{ type: "text", text: `inline subagent skipped: model ARN ${shortArn(model)} is blacklisted for this session — earlier call failed with: ${cachedFailure}. Pass a different model alias (haiku/opus) or fix the ARN in ~/.tcc/bedrock.json.` }],
					details: undefined,
					isError: true,
				};
			}
			const label = params.systemPrompt.split("\n")[0].slice(0, 40);
			const started = Date.now();
			ctx.ui.setStatus("tcc.delegate", `→ inline (${label})`);
			try {
				const result = await spawnPi({
					systemPrompt: params.systemPrompt,
					task: params.task,
					model,
					tools: mapTools(params.tools),
					cwd: ctx.cwd,
					signal,
					timeoutMs: params.timeoutMs ?? 10 * 60_000,
				});
				const seconds = ((Date.now() - started) / 1000).toFixed(1);
				if (result.reason === "fastFail") {
					const errSummary = extractBedrockError(result.stderr) ?? "Bedrock fatal error";
					brokenModels.set(model, errSummary);
					ctx.ui.notify(`tcc: model ARN ${shortArn(model)} is broken — ${errSummary}. Blacklisted for this session; fix in ~/.tcc/bedrock.json.`, "error");
					return {
						content: [{ type: "text", text: `inline subagent failed fast (${seconds}s): ${errSummary}\n\nModel ARN: ${model}\nBlacklisted for this session. ${PRESS_ON}\n\nstderr (tail):\n${result.stderr.slice(-1500)}` }],
						details: undefined,
						isError: true,
					};
				}
				if (result.reason !== "exit" || (result.exitCode !== 0 && result.exitCode !== null)) {
					return {
						content: [{ type: "text", text: describeFailure("inline subagent", result.reason, result.exitCode, seconds, result.attempts, result.stderr) }],
						details: undefined,
						isError: true,
					};
				}
				const retryNote = result.attempts > 1 ? `  [retried 1x after transient Bedrock error]` : "";
				return {
					content: [{ type: "text", text: `[inline — ${seconds}s${retryNote}]\n\n${result.stdout || "(no output)"}` }],
					details: undefined,
				};
			} finally {
				ctx.ui.setStatus("tcc.delegate", undefined);
			}
		},
	});

	pi.registerTool({
		name: "list_subagents",
		label: "List subagents",
		description: "List all available subagents discoverable in ~/.claude/agents/, ~/.pi/agent/agents/, and corresponding per-repo dirs. Use this when you need to know which specialized agents exist before calling `delegate`.",
		parameters: Type.Object({}),
		async execute(_id, _params, _s, _u, ctx) {
			return { content: [{ type: "text", text: describeAgents(getAgents(ctx.cwd)) }], details: undefined };
		},
	});

	// Cache-stable: getAgents() is cached per cwd and only invalidated on session_start.
	// The string built here must remain identical across turns within a session — Bedrock
	// prompt caching depends on it. If you ever want to inject something dynamic (e.g. a
	// recently-used agents list), do it as a separate non-cached block AFTER pi-ai's cache
	// point, not here in the system prompt.
	pi.on("before_agent_start", (event, ctx) => {
		const agents = getAgents(ctx.cwd);
		if (agents.length === 0) return;
		const names = agents.map((a) => a.name).join(", ");
		return { systemPrompt: `${event.systemPrompt}\n\n## Subagents on this machine\nAvailable via the \`delegate\` tool: ${names}. Call \`list_subagents\` to see descriptions.` };
	});
}
