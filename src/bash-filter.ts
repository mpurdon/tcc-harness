import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult } from "@earendil-works/pi-coding-agent";

// Intercepts bash tool_result content and trims verbose output before the
// model sees it. Uses the tool's own output characteristics — no external
// dependency. Three rules applied in priority order:
//
//  1. Test runners   — head 30 (setup/compile) + tail 150 (failures + summary)
//  2. git log        — cap at 200 lines if non-oneline format
//  3. General cap    — 500 lines for everything else
//
// Disable with TCC_BASH_FILTER=0.

const TEST_HEAD = 30;
const TEST_TAIL = 150;
const GIT_LOG_CAP = 200;
const GENERAL_CAP = 500;

// Matches common test-runner invocations
const TEST_RE =
	/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|jest\b|vitest\b|pytest\b|cargo\s+test\b|go\s+test\b|php\s+artisan\s+test\b|rspec\b|ruby.*_test\b/i;

// Matches `git log` that hasn't already been constrained to one-line output
const GIT_LOG_RE = /\bgit\s+log\b/;
const GIT_LOG_ONELINE_RE = /--oneline\b|--pretty=oneline\b|--format=oneline\b|--pretty="%h\b|--pretty='%h\b/;

function filterLines(cmd: string, raw: string): string | null {
	const lines = raw.split("\n");

	// Test runner: keep setup at top + failures/summary at bottom
	if (TEST_RE.test(cmd) && lines.length > TEST_HEAD + TEST_TAIL) {
		const head = lines.slice(0, TEST_HEAD);
		const tail = lines.slice(-TEST_TAIL);
		const skipped = lines.length - TEST_HEAD - TEST_TAIL;
		return [
			...head,
			`... [${skipped} lines of test output omitted — failures and summary below]`,
			...tail,
		].join("\n");
	}

	// git log: cap unless already in compact format
	if (GIT_LOG_RE.test(cmd) && !GIT_LOG_ONELINE_RE.test(cmd) && lines.length > GIT_LOG_CAP) {
		const skipped = lines.length - GIT_LOG_CAP;
		return [
			...lines.slice(0, GIT_LOG_CAP),
			`... [${skipped} more lines — add --oneline or --max-count=N to limit]`,
		].join("\n");
	}

	// General cap
	if (lines.length > GENERAL_CAP) {
		const skipped = lines.length - GENERAL_CAP;
		return [
			...lines.slice(0, GENERAL_CAP),
			`... [${skipped} more lines truncated — rerun with | head/tail/grep to target a section]`,
		].join("\n");
	}

	return null;
}

export default function bashFilterExtension(pi: ExtensionAPI): void {
	if (process.env.TCC_BASH_FILTER === "0") return;

	pi.on("tool_result", (event) => {
		if (!isBashToolResult(event)) return;
		const textNode = event.content.find((c) => c.type === "text");
		if (!textNode || textNode.type !== "text") return;
		const cmd = (event.input as { command?: string }).command ?? "";
		const filtered = filterLines(cmd, textNode.text);
		if (filtered === null) return;
		return {
			content: [
				{ type: "text" as const, text: filtered },
				...event.content.filter((c) => c.type !== "text"),
			],
		};
	});
}
