import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { userConfigDir } from "./config.ts";

function debugPath(sessionId: string): string {
	const dir = join(userConfigDir(), "debug");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${sessionId}.log`);
}

function safeJson(v: unknown): unknown {
	try {
		JSON.stringify(v);
		return v;
	} catch {
		return String(v);
	}
}

export default function debugExtension(pi: ExtensionAPI): void {
	if (process.env.TCC_DEBUG !== "1") return;

	let logPath: string | undefined;
	const append = (event: string, payload: Record<string, unknown> = {}) => {
		if (!logPath) return;
		try {
			appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload }, (_k, v) => (typeof v === "bigint" ? String(v) : v))}\n`);
		} catch {
			// best-effort; never let the debug log break a session
		}
	};

	pi.on("session_start", (_event, ctx) => {
		logPath = debugPath(ctx.sessionManager.getSessionId());
		append("session_start", { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() });
	});

	pi.on("model_select", (event) => {
		append("model_select", { model: event.model?.id, previous: event.previousModel?.id, source: event.source });
	});

	pi.on("before_agent_start", (event) => {
		append("before_agent_start", { promptPreview: event.prompt.slice(0, 200) });
	});

	pi.on("turn_start", (event) => {
		append("turn_start", { turnIndex: event.turnIndex });
	});

	pi.on("turn_end", (event) => {
		const usage = (event.message as { usage?: unknown } | undefined)?.usage;
		append("turn_end", { turnIndex: event.turnIndex, usage: safeJson(usage) });
	});

	pi.on("tool_call", (event) => {
		append("tool_call", { tool: event.toolName, toolCallId: event.toolCallId, input: safeJson(event.input) });
	});

	pi.on("tool_result", (event) => {
		append("tool_result", { tool: event.toolName, toolCallId: event.toolCallId, isError: event.isError });
	});

	pi.on("agent_end", () => {
		append("agent_end");
	});

	pi.on("session_shutdown", (event) => {
		append("session_shutdown", { reason: event.reason });
	});
}
