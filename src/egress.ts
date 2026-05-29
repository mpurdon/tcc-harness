import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadTccConfig } from "./util.ts";

// Best-effort network egress policy. This is NOT a kernel-level sandbox — it
// gates outbound URLs it can *see*: http(s) URLs in bash commands (curl/wget/…)
// and in tool inputs, plus the research tool's content fetches. A determined
// agent could obfuscate a URL past the regex; this is a guardrail against
// accidental/unwanted egress, layered on top of the permission rules.

type Mode = "off" | "allow" | "deny";

interface EgressPolicy {
	mode: Mode;
	allowed: string[];
	denied: string[];
}

interface EgressFile {
	egress?: {
		mode?: Mode;
		allowedDomains?: string[];
		deniedDomains?: string[];
	};
}

export interface EgressDecision {
	allowed: boolean;
	reason?: string;
}

const policyByCwd = new Map<string, EgressPolicy>();

function loadPolicy(cwd: string): EgressPolicy {
	const cached = policyByCwd.get(cwd);
	if (cached) return cached;
	const { global, project } = loadTccConfig<EgressFile>("permissions.json", cwd, "permissions");
	const g = global?.egress;
	const p = project?.egress;
	const policy: EgressPolicy = {
		mode: p?.mode ?? g?.mode ?? "off",
		allowed: [...(g?.allowedDomains ?? []), ...(p?.allowedDomains ?? [])].map(normalizeDomain),
		denied: [...(g?.deniedDomains ?? []), ...(p?.deniedDomains ?? [])].map(normalizeDomain),
	};
	policyByCwd.set(cwd, policy);
	return policy;
}

/** Drop a leading "*." so "*.example.com" and "example.com" behave identically:
 *  both match the apex and any subdomain. */
function normalizeDomain(d: string): string {
	return d.trim().toLowerCase().replace(/^\*\./, "");
}

function hostMatches(host: string, pattern: string): boolean {
	return host === pattern || host.endsWith(`.${pattern}`);
}

function hostOf(rawUrl: string): string | undefined {
	try {
		return new URL(rawUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

/** Decide a single URL against the active policy for `cwd` (defaults to the
 *  process cwd, which is the session's launch directory). */
export function evaluateUrl(rawUrl: string, cwd: string = process.cwd()): EgressDecision {
	const policy = loadPolicy(cwd);
	if (policy.mode === "off") return { allowed: true };
	const host = hostOf(rawUrl);
	if (!host) return { allowed: true }; // not a parseable URL — nothing to gate
	if (policy.denied.some((p) => hostMatches(host, p))) {
		return { allowed: false, reason: `egress to ${host} is on the deny list` };
	}
	if (policy.mode === "allow") {
		if (!policy.allowed.some((p) => hostMatches(host, p))) {
			return { allowed: false, reason: `egress to ${host} is not on the allow list (egress mode=allow)` };
		}
	}
	return { allowed: true };
}

const URL_RE = /https?:\/\/[^\s"'`<>)\]}]+/gi;

/** Evaluate every http(s) URL found in free text; returns the first violation. */
export function evaluateText(text: string, cwd: string = process.cwd()): EgressDecision {
	const policy = loadPolicy(cwd);
	if (policy.mode === "off") return { allowed: true };
	for (const match of text.matchAll(URL_RE)) {
		const decision = evaluateUrl(match[0], cwd);
		if (!decision.allowed) return decision;
	}
	return { allowed: true };
}

function targetText(event: ToolCallEvent): string {
	if (isToolCallEventType("bash", event)) return event.input.command;
	return JSON.stringify(event.input);
}

export default function egressExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		policyByCwd.delete(ctx.cwd); // pick up edits without a restart
	});

	pi.on("tool_call", async (event, ctx) => {
		const decision = evaluateText(targetText(event), ctx.cwd);
		if (!decision.allowed) {
			return { block: true, reason: `[egress] ${decision.reason}. Adjust egress.allowedDomains/deniedDomains in ~/.tcc/permissions.json.` };
		}
	});
}
