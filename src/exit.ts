import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi's only built-in quit command is /quit. Users coming from Claude Code,
// bash, python, etc. naturally type /exit (or /bye, /q). Without this
// extension, pi treats those as regular messages: the LLM replies "Goodbye!"
// and the app keeps running. Register them as proper shutdown aliases.
//
// /quit is intentionally NOT registered here — pi already handles it as a
// built-in, and registering it would trip pi's "extension command conflicts
// with built-in" warning on every startup.
export default function exitExtension(pi: ExtensionAPI): void {
	const aliases = [
		{ name: "exit", description: "Quit tcc (alias for /quit)" },
		{ name: "bye", description: "Quit tcc (alias for /quit)" },
		{ name: "q", description: "Quit tcc (alias for /quit)" },
	];
	for (const { name, description } of aliases) {
		pi.registerCommand(name, {
			description,
			handler: async (_args, ctx) => {
				ctx.shutdown();
			},
		});
	}
}
