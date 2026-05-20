import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logAuthEvent, runProcess } from "./util.ts";

function currentProfile(): string {
	return process.env.AWS_PROFILE ?? "claude-code-bedrock";
}

export default function loginExtension(pi: ExtensionAPI): void {
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
