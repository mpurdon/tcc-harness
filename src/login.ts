import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logAuthEvent, runProcess } from "./util.ts";

function currentProfile(): string {
	return process.env.AWS_PROFILE ?? "claude-code-bedrock";
}

// How long an STS validation result is trusted before re-checking.
// Set low enough to catch expiry mid-session; high enough to not add
// perceptible latency to every turn.
const STS_CACHE_MS = 5 * 60_000;

async function stsOk(profile: string): Promise<boolean> {
	const r = await runProcess({ cmd: "aws", args: ["sts", "get-caller-identity", "--profile", profile], timeoutMs: 8_000 });
	return r.reason === "exit" && r.exitCode === 0;
}

export default function loginExtension(pi: ExtensionAPI): void {
	// Tracks the last time STS confirmed the session was valid.
	// Initialised to 0; set to Date.now() on session_start since the wrapper
	// already validated SSO before launching pi.
	let lastStsOkAt = 0;

	pi.on("session_start", () => {
		// Wrapper pre-flight already passed — treat as fresh.
		lastStsOkAt = Date.now();
	});

	// Block each agent turn if the SSO window has elapsed. Runs before the
	// LLM call so the model never sees the confusing "clientId not present"
	// AWS SDK error. If refresh is needed, opens the browser flow inline and
	// waits for completion before the turn proceeds.
	pi.on("before_agent_start", async (_event, ctx) => {
		const now = Date.now();
		if (now - lastStsOkAt < STS_CACHE_MS) return;
		const profile = currentProfile();
		if (await stsOk(profile)) {
			lastStsOkAt = now;
			return;
		}
		// Session expired. Auto-refresh if we have a UI (TTY); otherwise just warn.
		logAuthEvent("expired_detected", profile, "before-agent-start");
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("tcc.login", `↻ ${profile}`);
		ctx.ui.notify(`AWS SSO session expired for '${profile}' — refreshing (complete browser flow if it opens)…`, "info");
		try {
			const login = await runProcess({ cmd: "aws", args: ["sso", "login", "--profile", profile], inheritStdio: true, timeoutMs: 5 * 60_000 });
			if (login.reason === "exit" && (login.exitCode === 0 || login.exitCode === null)) {
				lastStsOkAt = Date.now();
				logAuthEvent("login_success", profile, "auto-refresh");
				ctx.ui.notify(`SSO refreshed for '${profile}' — continuing.`, "info");
			} else {
				logAuthEvent("login_fail", profile, "auto-refresh");
				ctx.ui.notify(`SSO refresh failed (exit ${login.exitCode}) — run /tcc:sso manually.`, "error");
			}
		} finally {
			ctx.ui.setStatus("tcc.login", undefined);
		}
	});

	// Pi's built-in /login is for provider OAuth; ours is the AWS SSO refresh.
	pi.registerCommand("tcc:sso", {
		description: "Refresh AWS SSO session for the current Bedrock profile (runs `aws sso login` and re-validates).",
		handler: async (args, ctx) => {
			const profile = args.trim() || currentProfile();
			ctx.ui.setStatus("tcc.login", `→ ${profile}`);
			try {
				ctx.ui.notify(`refreshing SSO for '${profile}' — complete the browser flow if it opens…`, "info");

				const login = await runProcess({ cmd: "aws", args: ["sso", "login", "--profile", profile], inheritStdio: true, timeoutMs: 5 * 60_000 });
				if (login.reason !== "exit" || (login.exitCode !== 0 && login.exitCode !== null)) {
					logAuthEvent("login_fail", profile, "slash-login");
					ctx.ui.notify(`aws sso login failed (${login.reason}, exit ${login.exitCode})`, "error");
					return;
				}

				const sts = await runProcess({ cmd: "aws", args: ["sts", "get-caller-identity", "--profile", profile], timeoutMs: 10_000 });
				if (sts.reason !== "exit" || sts.exitCode !== 0) {
					logAuthEvent("login_fail", profile, "slash-login");
					ctx.ui.notify(`SSO still invalid after login — check the '${profile}' profile`, "error");
					return;
				}
				logAuthEvent("login_success", profile, "slash-login");

				// Refresh the wrapper's SSO cache file so the next `tcc` start skips its own re-check.
				try {
					const cache = join(homedir(), ".tcc", `.sso-ok-${profile}`);
					unlinkSync(cache);
				} catch {
					// File may not exist; touch will be handled on next wrapper invocation.
				}

				ctx.ui.notify(`SSO refreshed for '${profile}'. ${sts.stdout.split("\n")[2]?.trim() ?? ""}`, "info");
			} finally {
				ctx.ui.setStatus("tcc.login", undefined);
			}
		},
	});
}
