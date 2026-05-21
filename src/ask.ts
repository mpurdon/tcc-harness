import { Type } from "typebox";
import { Container, Input, SelectList, SettingsList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable, SelectItem, SettingItem } from "@earendil-works/pi-tui";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const OTHER_LABEL = "Other (type your own)";
const OTHER_VALUE = "__other__";

interface OptionDef {
	label: string;
	description?: string;
}

interface QuestionDef {
	question: string;
	header: string;
	multiSelect?: boolean;
	options: OptionDef[];
}

interface Answer {
	question: string;
	header: string;
	answer: string; // joined with ", " for multi-select
	custom?: string; // present if user picked Other
}

/**
 * One-question-at-a-time wizard. Keeps a single child component active
 * (SelectList → Input for Other, SettingsList → optional Input for Other).
 * Esc on the initial picker = cancel wizard; Esc inside an Other-input
 * goes back to the picker so the user can change their mind.
 */
class Wizard extends Container implements Focusable {
	focused = false;
	private readonly questions: QuestionDef[];
	private readonly onSubmit: (answers: Answer[]) => void;
	private readonly onCancel: () => void;
	private readonly answers: Answer[] = [];
	private currentIndex = 0;
	private currentMultiToggles = new Map<string, boolean>();
	private currentChild!: Component & { handleInput(data: string): void };
	private currentMode: "options" | "freetext" = "options";

	constructor(questions: QuestionDef[], onSubmit: (answers: Answer[]) => void, onCancel: () => void) {
		super();
		this.questions = questions;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
		this.startQuestion();
	}

	private startQuestion(): void {
		const q = this.questions[this.currentIndex];
		this.currentMode = "options";
		this.currentMultiToggles = new Map();
		this.currentChild = q.multiSelect ? this.buildMultiPicker(q) : this.buildSinglePicker(q);
		this.clear();
		this.addChild(this.currentChild);
	}

	private buildSinglePicker(q: QuestionDef): SelectList {
		// Index-prefixed value so duplicate labels (or a real option literally named
		// "Other (type your own)") can't collide with the auto-appended Other entry.
		const items: SelectItem[] = q.options.map((o, i) => ({ value: `opt:${i}`, label: o.label, description: o.description ?? "" }));
		items.push({ value: OTHER_VALUE, label: OTHER_LABEL, description: "Provide a free-text answer." });
		const list = new SelectList(items, Math.min(items.length + 1, 10), getSelectListTheme());
		list.onSelect = (item) => {
			if (item.value === OTHER_VALUE) this.enterFreetext(q, []);
			else {
				const idx = Number(String(item.value).slice(4));
				const label = q.options[idx].label;
				this.answers.push({ question: q.question, header: q.header, answer: label });
				this.advance();
			}
		};
		list.onCancel = () => this.onCancel();
		return list;
	}

	private buildMultiPicker(q: QuestionDef): SettingsList {
		// Stable, collision-free ids. SettingsList keys toggles by id; we translate
		// back to the original label when committing.
		const items: SettingItem[] = q.options.map((o, i) => ({
			id: `opt:${i}`,
			label: o.label,
			description: o.description ?? "",
			currentValue: "off",
			values: ["off", "on"],
		}));
		items.push({ id: OTHER_VALUE, label: OTHER_LABEL, description: "Toggle on to add a free-text answer too.", currentValue: "off", values: ["off", "on"] });
		for (const it of items) this.currentMultiToggles.set(it.id, false);
		// SettingsList Esc commits the toggles (pi-tui has no separate "done" gesture).
		// The hint line tells the user this. If the user committed with zero toggles
		// it's almost always a misfire — treat that as cancel-wizard rather than
		// silently advancing with an empty answer.
		return new SettingsList(
			items,
			Math.min(items.length + 1, 12),
			getSettingsListTheme(),
			(id, newValue) => this.currentMultiToggles.set(id, newValue === "on"),
			() => this.applyMultiSelect(q),
		);
	}

	private applyMultiSelect(q: QuestionDef): void {
		const pickedIds = [...this.currentMultiToggles.entries()].filter(([_, on]) => on).map(([k]) => k);
		if (pickedIds.length === 0) {
			this.onCancel();
			return;
		}
		const wantsOther = pickedIds.includes(OTHER_VALUE);
		const concreteLabels = pickedIds
			.filter((id) => id !== OTHER_VALUE)
			.map((id) => q.options[Number(id.slice(4))].label);
		if (wantsOther) {
			this.enterFreetext(q, concreteLabels);
			return;
		}
		this.answers.push({ question: q.question, header: q.header, answer: concreteLabels.join(", ") });
		this.advance();
	}

	private enterFreetext(q: QuestionDef, presetSelections: string[]): void {
		this.currentMode = "freetext";
		const input = new Input();
		input.focused = true;
		input.onSubmit = (value) => {
			const text = value.trim();
			const joined = presetSelections.length > 0 ? `${presetSelections.join(", ")} + ${text || "(empty)"}` : text || "(empty)";
			this.answers.push({ question: q.question, header: q.header, answer: joined, custom: text });
			this.advance();
		};
		input.onEscape = () => this.startQuestion(); // back to the picker, give them a chance to change their mind
		this.currentChild = input as unknown as Component & { handleInput(data: string): void };
		this.clear();
		this.addChild(this.currentChild);
	}

	private advance(): void {
		this.currentIndex++;
		if (this.currentIndex >= this.questions.length) {
			this.onSubmit(this.answers);
			return;
		}
		this.startQuestion();
	}

	handleInput(data: string): void {
		// Delegate to the active child. Each child manages its own Esc semantics:
		//   - SelectList Esc → onCancel → cancel wizard
		//   - SettingsList Esc → "apply and advance" (or cancel if zero toggles)
		//   - Input Esc → back to picker
		this.currentChild.handleInput(data);
		this.invalidate();
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		const total = this.questions.length;
		const progress = `[${this.currentIndex + 1}/${total}]`;
		const q = this.questions[this.currentIndex];
		const titleLine = `${BOLD}${CYAN}tcc has ${total} question${total === 1 ? "" : "s"}${RESET}  ${DIM}${progress}${RESET}`;
		pushFit(lines, width, titleLine);
		lines.push("");
		// Header tag + question text
		const tag = `${GREEN}[${q.header}]${RESET}`;
		const headerLine = `${tag} ${BOLD}${q.question}${RESET}`;
		for (const wrapped of wrapAnsi(headerLine, width)) pushFit(lines, width, wrapped);
		// Render any earlier answers in dim so the user has context
		if (this.answers.length > 0) {
			lines.push("");
			pushFit(lines, width, `${DIM}Earlier answers:${RESET}`);
			for (const a of this.answers) {
				for (const wrapped of wrap(`[${a.header}] ${a.answer || "(empty)"}`, width - 2)) {
					pushFit(lines, width, `  ${DIM}${wrapped}${RESET}`);
				}
			}
		}
		lines.push("");
		// Mode-specific child + hint
		if (this.currentMode === "freetext") {
			pushFit(lines, width, `${DIM}Type your answer; Enter to submit; Esc to return to the option list.${RESET}`);
			const childLines = this.currentChild.render(Math.max(20, width - 4));
			for (const child of childLines) pushFit(lines, width, `  ${DIM}>${RESET} ${child}`);
		} else {
			const hint = q.multiSelect
				? `${DIM}↑↓ navigate · Space/Enter toggle · Esc apply & advance${RESET}`
				: `${DIM}↑↓ navigate · Enter pick & advance · Esc cancel wizard${RESET}`;
			pushFit(lines, width, hint);
			const childLines = this.currentChild.render(width);
			for (const child of childLines) pushFit(lines, width, child);
		}
		return lines;
	}
}

function wrap(text: string, width: number): string[] {
	if (width <= 10) return [text];
	const out: string[] = [];
	for (const para of text.split("\n")) {
		const words = para.split(/\s+/).flatMap((w) => splitLongWord(w, width));
		let line = "";
		for (const w of words) {
			if (!line) line = w;
			else if (line.length + 1 + w.length <= width) line = `${line} ${w}`;
			else {
				out.push(line);
				line = w;
			}
		}
		if (line) out.push(line);
	}
	return out.length > 0 ? out : [""];
}

function wrapAnsi(text: string, width: number): string[] {
	// Trust input that's small enough; otherwise wrap on the visible chars and
	// re-apply the leading style codes to each wrapped line so we don't drop
	// colors on overflow. RESET is appended so styles don't bleed past the line.
	if (visibleWidth(text) <= width) return [text];
	const leadingCodes = (text.match(/^(?:\x1b\[[0-9;]*m)+/)?.[0]) ?? "";
	const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
	const wrapped = wrap(stripped, width);
	if (!leadingCodes) return wrapped;
	return wrapped.map((line) => `${leadingCodes}${line}${RESET}`);
}

function splitLongWord(word: string, width: number): string[] {
	if (word.length <= width) return [word];
	const out: string[] = [];
	for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
	return out;
}

function pushFit(lines: string[], width: number, line: string): void {
	if (visibleWidth(line) <= width) {
		lines.push(line);
		return;
	}
	lines.push(truncateToWidth(line, width));
}

export default function askExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user 1-6 structured clarifying questions in a sequential wizard. " +
			"Each question has a short header (max 12 chars), the full question, and 2-6 predefined option labels. " +
			"An 'Other (type your own)' option is automatically appended for free text. " +
			"Set `multiSelect: true` when the user may pick multiple options at once. " +
			"Use this when you genuinely need a decision only the user can make (real fork in the road, ambiguous requirements). " +
			"Do NOT use it for things you could grep / read / run yourself. " +
			"Returns a JSON array of {question, header, answer, custom?} per question. Esc on the first question (or zero toggles on a multi-select) cancels the wizard.",
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "The full question, ending in '?'." }),
					header: Type.String({ maxLength: 12, description: "Short label/tag shown as a chip before the question (max 12 chars). E.g., 'Detail', 'Auth'." }),
					multiSelect: Type.Optional(Type.Boolean({ description: "true when the user may pick multiple options. Default false." })),
					options: Type.Array(
						Type.Object({
							label: Type.String({ description: "Option text (1-5 words ideally)." }),
							description: Type.Optional(Type.String({ description: "Optional one-line context for this option." })),
						}),
						{ minItems: 2, maxItems: 6, description: "2-6 mutually exclusive options (or independent toggles when multiSelect). An 'Other' option is auto-appended." },
					),
				}),
				{ minItems: 1, maxItems: 6, description: "1-6 questions, ordered so that earlier answers inform later questions." },
			),
		}),
		async execute(_id, params, _signal, _u, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "ask_user: no UI (headless mode). Embed the questions in your reply text and the user will answer in their next message." }],
					details: undefined,
					isError: true,
				};
			}
			const questions = params.questions as QuestionDef[];
			const result = await ctx.ui.custom<Answer[] | undefined>((_tui, _theme, _kb, done) => {
				return new Wizard(questions, (answers) => done(answers), () => done(undefined)) as unknown as Component;
			});
			if (!result) {
				return {
					content: [{ type: "text", text: "user cancelled (Esc) — they did not answer. Reconsider whether the questions were necessary, or rephrase and try again." }],
					details: undefined,
					isError: true,
				};
			}
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: undefined };
		},
	});
}
