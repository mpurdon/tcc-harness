import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT = `Session retrospective. Look back at what we did *in this session* — the user prompts, the work we performed, and the conclusions — and propose 0–3 things worth saving as long-term memories.

For each candidate, give:
- **Slug** (kebab-case, ≤6 words)
- **Type** — one of \`user\` (about the user themselves), \`feedback\` (a correction or validated approach), \`project\` (a fact about a specific project / codebase), \`reference\` (a pointer to an external resource)
- **Scope** — \`global\` (carries across all projects) or \`project\` (only this repo)
- **One-line description**
- **Body** (markdown — 1–3 sentences max)

Use the following bar:
- Save only what's non-obvious *and* would still be useful weeks from now.
- Do NOT save things already documented in the code or git history (those are already retrievable).
- Do NOT save corrections that fix one-off mistakes — only patterns that recur.
- If nothing meets the bar, say so plainly: "Nothing worth saving from this session."

Format your output as a numbered list of proposals. Do NOT call \`memory_save\` directly — the user reviews and accepts each one. After they pick which ones to keep, run \`memory_save\` for those only.`;

export default function retroExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:retro", {
		description: "Ask the agent to propose 0–3 memories worth saving from this session (you approve before they're written).",
		handler: async () => {
			// Custom message with display:false hides the long PROMPT from the
			// transcript; the LLM still receives it (convertToLlm promotes
			// role:"custom" → role:"user"). User sees the agent start working
			// instead of a giant prompt scrolling past first.
			pi.sendMessage(
				{ customType: "tcc:retro:invocation", content: PROMPT, display: false },
				{ triggerTurn: true },
			);
		},
	});
}
