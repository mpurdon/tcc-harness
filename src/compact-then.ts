import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { playNotification } from "./notify.ts";

// /tcc:compact-then <prompt>
//
// Runs pi's compaction, then sends <prompt> as a user message once the
// summary has settled. Useful when you know the next thing you want to do
// AFTER compacting (e.g. "now write the PR description", "now run the test
// suite and fix any failures") — saves the manual "type /compact, wait for
// it to finish, then type the prompt" round-trip.
//
// Without a prompt, this is equivalent to pi's built-in /compact.
export default function compactThenExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:compact-then", {
		description: "Compact the session, then send a follow-up prompt when compaction finishes. Usage: /tcc:compact-then <prompt>",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				// No prompt → behave like a plain compact. Still useful as a way to
				// trigger compaction from a slash command in case the user typed
				// the wrong command name.
				ctx.compact();
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify(
					"/tcc:compact-then: agent is mid-turn — wait for the current response, then re-run.",
					"warning",
				);
				return;
			}
			ctx.ui.notify(`compacting, then will send: ${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}`, "info");
			ctx.compact({
				onComplete: () => {
					playNotification("compact", "compaction finished — running follow-up");
					// display:false: the user already saw their prompt echoed in
					// the "compacting, then will send: …" notify above. Showing it
					// again in the transcript would be noise. The LLM still gets
					// it via convertToLlm (role:"custom" → role:"user").
					pi.sendMessage(
						{ customType: "tcc:compact-then:invocation", content: prompt, display: false },
						{ triggerTurn: true },
					);
				},
				onError: (err) => {
					ctx.ui.notify(`/tcc:compact-then: compaction failed (${err.message}). Follow-up prompt not sent.`, "error");
				},
			});
		},
	});
}
