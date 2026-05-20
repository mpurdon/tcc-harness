import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

interface BedrockSettings {
	env?: {
		ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
		ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
		ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
		AWS_REGION?: string;
	};
}

type BedrockTier = "sonnet" | "opus" | "haiku";

interface BedrockSlot {
	tier: BedrockTier;
	arn: string;
	displayName: string;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	maxTokens: number;
}

// Per-million-token Bedrock pricing (USD). Tracking is informational; actual
// billing happens server-side. Update if AWS changes prices.
const BEDROCK_PRICING: Record<BedrockTier, BedrockSlot["cost"]> = {
	sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const BEDROCK_MAX_TOKENS: Record<BedrockTier, number> = {
	sonnet: 64_000,
	opus: 32_000,
	haiku: 8_192,
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
	const slots: BedrockSlot[] = (Object.keys(arns) as BedrockTier[]).map((tier) => ({
		tier,
		arn: arns[tier],
		displayName: `${tier[0].toUpperCase()}${tier.slice(1)} (Bedrock)`,
		cost: BEDROCK_PRICING[tier],
		maxTokens: BEDROCK_MAX_TOKENS[tier],
	}));

	const models: ProviderModelConfig[] = slots
		.filter((s) => s.arn)
		.map((s) => ({
			id: s.arn,
			name: s.displayName,
			api: "bedrock-converse-stream",
			reasoning: true,
			input: ["text", "image"],
			cost: s.cost,
			contextWindow: 200_000,
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
