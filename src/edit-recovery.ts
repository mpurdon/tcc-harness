import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ResultContent = { type: "text"; text: string } | { type: "image"; [key: string]: unknown };

// Pi's built-in `edit` fails with a bare "Could not find the exact text in
// <path>" when oldText drifts from disk (whitespace changes, the file was
// touched between read and edit, the model misremembered a line). The LLM's
// usual recovery is to re-`read` the whole file — often hundreds of lines —
// then re-emit a fixed edit. That's hundreds of tokens for what is almost
// always a 5-line discrepancy.
//
// This extension intercepts failed `edit` results and appends a localized view
// of where the LLM probably *meant* to edit, anchored on the first non-empty
// line of oldText. With this in hand the model can usually fix the edit in one
// follow-up call without re-reading.
//
// Why not retry with fuzzy matching here? Pi's edit already does whitespace-
// tolerant fuzzy matching internally (edit-diff.js:86). If it still failed,
// the drift is semantic and a silent fuzzy patch risks editing the wrong
// region. Surfacing context lets the model decide.

interface EditInput {
	path?: unknown;
	edits?: unknown;
	// Legacy single-edit shape some clients still emit.
	oldText?: unknown;
	newText?: unknown;
}

interface NormalizedEdit {
	oldText: string;
	newText: string;
}

const MAX_ANCHOR_LEN = 120;
const CONTEXT_LINES = 6;
const MAX_MATCHES_TO_SHOW = 3;

function normalizeEdits(input: EditInput): NormalizedEdit[] {
	const out: NormalizedEdit[] = [];
	if (Array.isArray(input.edits)) {
		for (const e of input.edits) {
			if (e && typeof e === "object" && typeof (e as NormalizedEdit).oldText === "string" && typeof (e as NormalizedEdit).newText === "string") {
				out.push({ oldText: (e as NormalizedEdit).oldText, newText: (e as NormalizedEdit).newText });
			}
		}
	}
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		out.push({ oldText: input.oldText, newText: input.newText });
	}
	return out;
}

function firstAnchor(oldText: string): string | undefined {
	for (const line of oldText.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length >= 3) return trimmed.slice(0, MAX_ANCHOR_LEN);
	}
	return undefined;
}

function findAnchorMatches(fileLines: string[], anchor: string): number[] {
	const hits: number[] = [];
	for (let i = 0; i < fileLines.length; i++) {
		if (fileLines[i].includes(anchor)) hits.push(i);
	}
	return hits;
}

function renderWindow(fileLines: string[], centerIdx: number): string {
	const start = Math.max(0, centerIdx - CONTEXT_LINES);
	const end = Math.min(fileLines.length, centerIdx + CONTEXT_LINES + 1);
	const width = String(end).length;
	const out: string[] = [];
	for (let i = start; i < end; i++) {
		const marker = i === centerIdx ? "→" : " ";
		out.push(`${marker} ${String(i + 1).padStart(width)} | ${fileLines[i]}`);
	}
	return out.join("\n");
}

function resolveEditPath(filePath: string, cwd: string): string {
	// Pi's edit tool resolves `~` internally before reading, but the input we
	// receive in tool_result is the original (un-expanded) string from the LLM.
	// Without this we'd resolve `~/foo` against cwd as `<cwd>/~/foo`, fail to
	// read it, and silently return no recovery hint.
	if (filePath === "~") return homedir();
	if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
	return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

function buildRecoveryHint(filePath: string, cwd: string, edits: NormalizedEdit[]): string | undefined {
	const absPath = resolveEditPath(filePath, cwd);
	let content: string;
	try {
		content = readFileSync(absPath, "utf8");
	} catch (err) {
		// Surface read failures rather than silently giving up — the LLM is left
		// with the bare "Could not find the exact text" and no clue why recovery
		// didn't trigger. One short line is much better than nothing.
		const msg = err instanceof Error ? err.message : String(err);
		return `\n\n[tcc edit-recovery] could not read ${absPath} for recovery context: ${msg.slice(0, 200)}. Re-read the file with the read tool to refresh your view.`;
	}
	const lines = content.split("\n");
	const blocks: string[] = [];
	for (let i = 0; i < edits.length; i++) {
		const anchor = firstAnchor(edits[i].oldText);
		if (!anchor) continue;
		const matches = findAnchorMatches(lines, anchor);
		const label = edits.length === 1 ? "edit" : `edits[${i}]`;
		if (matches.length === 0) {
			blocks.push(`${label}: anchor ${JSON.stringify(anchor)} not found in file (file has ${lines.length} lines).`);
			continue;
		}
		const shown = matches.slice(0, MAX_MATCHES_TO_SHOW);
		const moreSuffix = matches.length > shown.length ? ` (+${matches.length - shown.length} more)` : "";
		const windows = shown.map((idx) => renderWindow(lines, idx)).join("\n\n");
		blocks.push(`${label}: anchor ${JSON.stringify(anchor)} found at line${shown.length === 1 ? "" : "s"} ${shown.map((i) => i + 1).join(", ")}${moreSuffix}:\n\n${windows}`);
	}
	if (blocks.length === 0) return undefined;
	return `\n\n[tcc edit-recovery] current file state near your intended edit (so you don't have to re-read the whole file):\n\n${blocks.join("\n\n")}`;
}

export default function editRecoveryExtension(pi: ExtensionAPI): void {
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "edit" || !event.isError) return;
		const input = event.input as EditInput;
		const filePath = typeof input.path === "string" ? input.path : undefined;
		if (!filePath) return;
		const edits = normalizeEdits(input);
		if (edits.length === 0) return;
		const hint = buildRecoveryHint(filePath, ctx.cwd, edits);
		if (!hint) return;
		const newContent = (event.content as ResultContent[]).map((c) => {
			if (c.type !== "text") return c;
			return { ...c, text: `${c.text}${hint}` };
		});
		// If for some reason there was no text content at all, add one.
		if (!newContent.some((c) => c.type === "text")) {
			newContent.push({ type: "text", text: hint.trimStart() });
		}
		// `as` cast: the public ToolResultEventResult.content type pulls in
		// TextContent/ImageContent from pi-ai, which isn't re-exported from
		// pi-coding-agent. Our shape is structurally identical.
		return { content: newContent } as unknown as { content: typeof event.content };
	});
}
