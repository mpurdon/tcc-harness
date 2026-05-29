import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

interface BedrockSettings {
	env?: {
		ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
		ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
		ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
		ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES?: string;
		ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES?: string;
		ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES?: string;
		AWS_REGION?: string;
	};
}

type BedrockTier = "sonnet" | "opus" | "haiku";
type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

interface BedrockSlot {
	tier: BedrockTier;
	arn: string;
	displayName: string;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	maxTokens: number;
	contextWindow: number;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

const CAPABILITY_KEYS: Record<BedrockTier, keyof NonNullable<BedrockSettings["env"]>> = {
	sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
	opus: "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
	haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
};

// Translate a tier's Claude-Code-style capabilities string (e.g.
// "thinking,effort,xhigh_effort,max_effort") into pi's per-model thinking
// metadata. Two facts drive the mapping, both from the pi SDK:
//   - `reasoning: true` already unlocks off→high; a model only loses those if
//     it can't think at all (no `thinking` capability).
//   - pi's thinking scale tops out at "xhigh", and that level is exposed *only*
//     when `thinkingLevelMap.xhigh` is explicitly set (see getSupportedThinkingLevels).
// Claude Code's `xhigh_effort` is the matching ceiling, so we map it to
// { xhigh: "xhigh" } — which reproduces pi's own built-in registry (Opus gets
// xhigh, Sonnet/Haiku don't). `max_effort` has no distinct slot above xhigh, so
// it is intentionally not mapped. Missing capabilities → reasoning stays true
// (back-compat with minimal bedrock.json files that predate these keys).
function thinkingFor(caps: string | undefined): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
	if (!caps) return { reasoning: true };
	const set = new Set(caps.split(",").map((s) => s.trim()).filter(Boolean));
	const reasoning = set.has("thinking");
	if (reasoning && set.has("xhigh_effort")) return { reasoning, thinkingLevelMap: { xhigh: "xhigh" } };
	return { reasoning };
}

// Per-million-token Bedrock pricing (USD). Tracking is informational; actual
// billing happens server-side. Update if AWS changes prices. Opus is the 4.5+
// generation ($5/$25) — the older $15/$75 was Opus 4.1 pricing.
const BEDROCK_PRICING: Record<BedrockTier, BedrockSlot["cost"]> = {
	sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const BEDROCK_MAX_TOKENS: Record<BedrockTier, number> = {
	sonnet: 64_000,
	opus: 128_000,
	haiku: 8_192,
};

// Context window per tier. Opus 4.5+ runs a 1M window; Sonnet/Haiku stay at the
// standard 200k unless a profile enables the 1M beta.
const BEDROCK_CONTEXT_WINDOW: Record<BedrockTier, number> = {
	sonnet: 200_000,
	opus: 1_000_000,
	haiku: 200_000,
};

// Canonical location is ~/.tcc/bedrock.json. ~/.claude/trajector-settings.json
// is read as a fallback for users migrating from the pre-public-rename era.
const SETTINGS_PATHS = [
	join(homedir(), ".tcc", "bedrock.json"),
	join(homedir(), ".claude", "trajector-settings.json"),
];

function loadSettings(): BedrockSettings["env"] {
	for (const path of SETTINGS_PATHS) {
		if (!existsSync(path)) continue;
		try {
			return (JSON.parse(readFileSync(path, "utf8")) as BedrockSettings).env ?? {};
		} catch {
			// try next candidate
		}
	}
	return {};
}

/**
 * Replace the built-in amazon-bedrock model list with the user's three
 * inference-profile ARNs. Same `api: "bedrock-converse-stream"` so pi keeps
 * routing through its built-in Bedrock SDK plumbing — we just give it a model
 * registry it actually recognises, which kills the "model not found" warning
 * and gives the /model picker friendly names.
 */
export default function bedrockExtension(pi: ExtensionAPI): void {
	const env = loadSettings();
	const region = env?.AWS_REGION ?? "us-east-2";
	const arns: Record<BedrockTier, string> = {
		sonnet: env?.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "",
		opus: env?.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "",
		haiku: env?.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "",
	};
	const slots: BedrockSlot[] = (Object.keys(arns) as BedrockTier[]).map((tier) => {
		const thinking = thinkingFor(env?.[CAPABILITY_KEYS[tier]]);
		return {
			tier,
			arn: arns[tier],
			displayName: `${tier[0].toUpperCase()}${tier.slice(1)} (Bedrock)`,
			cost: BEDROCK_PRICING[tier],
			maxTokens: BEDROCK_MAX_TOKENS[tier],
			contextWindow: BEDROCK_CONTEXT_WINDOW[tier],
			reasoning: thinking.reasoning,
			thinkingLevelMap: thinking.thinkingLevelMap,
		};
	});

	const models: ProviderModelConfig[] = slots
		.filter((s) => s.arn)
		.map((s) => ({
			id: s.arn,
			name: s.displayName,
			api: "bedrock-converse-stream",
			reasoning: s.reasoning,
			...(s.thinkingLevelMap ? { thinkingLevelMap: s.thinkingLevelMap } : {}),
			input: ["text", "image"],
			cost: s.cost,
			contextWindow: s.contextWindow,
			maxTokens: s.maxTokens,
		}));

	if (models.length === 0) {
		console.error("[tcc] bedrock: no inference profile ARNs found in ~/.tcc/bedrock.json — leaving built-in model list intact (run `tcc doctor` for setup help)");
		return;
	}

	pi.registerProvider("amazon-bedrock", {
		baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
		// pi requires an apiKey env-var name when models are defined, but Bedrock
		// auth runs through the AWS SigV4 SDK chain (not an HTTP Authorization
		// header). Point at AWS_REGION — it's always set by our wrapper, exists,
		// and is never sent as a credential anywhere.
		apiKey: "AWS_REGION",
		api: "bedrock-converse-stream",
		models,
	});
}
