import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT = `Onboard this repository. Produce a concise mental model in two artifacts.

## Step 1 — discover
Use the available tools (find_files, search_text, read, bash) to learn:
1. **What this is.** Read README.md (first ~200 lines is enough). Note the project's purpose in one sentence.
2. **Tech stack.** Detect language + framework from manifest files: package.json, Cargo.toml, pyproject.toml, requirements.txt, go.mod, Gemfile, build.gradle*, pom.xml, deno.json, bun.lock, sst.config.ts.
3. **Common commands.** From those manifests (esp. package.json "scripts"), pick the canonical: install, build, test, lint, dev/start.
4. **Repo shape.** Top-level dirs (depth 2 only) and what each contains in one phrase.
5. **VCS context.** \`git -C . log --oneline -10\`, \`git -C . remote -v\`, default branch.
6. **Existing AGENTS.md / CLAUDE.md.** If present, don't clobber — propose additions instead.

Cap reads: read at most 8 files, ≤300 lines each. Use search_text/find_files before reading.

## Step 2 — write AGENTS.md
Write (or extend) a concise AGENTS.md at the git root with:
- One-sentence project description
- Tech stack
- Canonical commands (install / build / test / lint / dev) with the exact command lines
- A short "house style" note if any conventions are obvious (lint config, .editorconfig, prettier)
- Anything load-bearing the next agent needs to know (env vars, MCP servers, gotchas)

Keep it under 60 lines. No fluff. Code-first.

## Step 3 — save 1-3 project memories
Call memory_save with scope='project' for the highest-signal facts:
- A 'project' memory: what this repo is + tech stack + canonical commands
- A 'reference' memory: any non-obvious external resource references (dashboards, runbooks, related repos)
- A 'feedback' memory only if the README explicitly states conventions ("we always X", "never Y")

Use short kebab-case slugs ('project-overview', 'common-commands').

## Report
End with a 5-line summary listing what was discovered, what you wrote where, and any open questions for the user.`;

export default function onboardExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:onboard", {
		description: "Scan the current repo, write AGENTS.md, and save project memories.",
		handler: async () => {
			// Hide the long PROMPT from the transcript via display:false. The LLM
			// still receives the content because convertToLlm promotes
			// role:"custom" → role:"user" during the turn.
			pi.sendMessage(
				{ customType: "tcc:onboard:invocation", content: PROMPT, display: false },
				{ triggerTurn: true },
			);
		},
	});
}
