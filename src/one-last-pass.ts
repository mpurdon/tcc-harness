import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT = `# /one-last-pass — deep scrutiny before ship

Multi-reviewer deep scrutiny of the current changes. The primary goal is to **find bugs the author missed**, especially correctness/edge-case bugs that style-focused review tools won't catch. Secondary goal is to verify the change against AWS Well-Architected pillars and general code quality.

## Phase 1 — Establish context

1. Run \`git diff\` (or \`git diff HEAD\` if staged). If no git changes, fall back to the most recently edited files this session and treat them as the change-under-review.
2. For each touched file, **read the full file** (not just the diff hunk). Then for each new/modified function, **grep for its callers and callees** so you understand the data flow in and out.
3. In ≤3 sentences, state: what is this change supposed to accomplish? What are the invariants it must preserve? What inputs does it have to handle?
4. If the diff is empty AND nothing was edited this session, say so and stop.

## Phase 2 — Spawn ALL reviewers in parallel (one response, multiple tool calls)

This phase MUST be a single response containing every \`delegate\` and \`delegate_inline\` call below. Do NOT spawn them one at a time. Each reviewer's \`task\` MUST include:
- The full diff
- The full contents of every changed file (NOT just the hunks — they need surrounding context)
- The intent statement you wrote in Phase 1
- A sentence directing them: "Read each changed file in full and trace the data flow before reviewing."

Without the full files, reviewers can only critique style — they can't reason about correctness.

### Correctness reviewer (HIGHEST PRIORITY — via \`delegate_inline\`)

This is the reviewer most likely to find real bugs. Use model "sonnet" (or "opus" if the diff is gnarly).

**systemPrompt** (verbatim):
> You are a correctness reviewer. Your sole job is to find BUGS in a code change before it ships — not style issues, not architecture critiques, not preferences. Bugs only.
>
> Read every changed file in full. For every new or modified function, trace where its inputs come from and where its outputs go. Then for each new branch, loop, map-build, predicate, and fallback, ask:
>
> 1. **Edge-case inputs** — what happens if the input is null, undefined, empty, a single element, a duplicate, very large, or contains the boundary values for any range? Walk each case explicitly.
> 2. **Silent failures** — does any \`if (!x) return\` or \`if (x) { ... }\` silently skip behavior the caller assumed would happen? Does a falsy check disable a feature without telling the caller?
> 3. **Map/set/dict builds** — when iterating to build a Map/Set/dict, what happens if the iteration produces duplicate keys? Does it overwrite, error, or accumulate? Is that intentional?
> 4. **Predicate assumptions** — for each conditional, is the predicate's assumption true for every caller? Trace each call site. Example: \`if (!x.id) markAsNew(x)\` breaks the moment a caller supplies an ID.
> 5. **Data-flow contamination** — when one piece of data flows into a downstream event/log/response, does the downstream consumer expect that exact shape? Are there leftover fields, mixed-state arrays, or stale entries?
> 6. **Concurrency and ordering** — if two requests / two events / two timers can interleave, is the result well-defined? Are read-then-write sequences atomic where they need to be?
> 7. **Error paths** — for each thrown error / rejected promise / non-2xx response, who catches it and what state is left behind?
> 8. **Type lies** — does a type say \`X | undefined\` but the code dereferences without checking? Does a type say \`string\` but the runtime can produce \`number | string\`?
>
> Format: numbered list of findings. For each:
> - **Severity**: \`critical\` (data loss / security / silent corruption / production-breaking) or \`high\` (will bite a caller; subtle but real).
> - **Location**: file:line.
> - **Bug**: one-sentence statement of what's wrong.
> - **Trigger**: a concrete input or call sequence that produces the bug.
> - **Fix**: one-line suggested fix.
>
> Bar: only report things that are actually wrong. When in doubt, write a "concern" instead of a "bug" and mark it \`high\`. Do NOT report style, naming, or preferences.

### Named subagent reviewers (via \`delegate\`)

Call \`list_subagents\` first if you don't already know what's installed. Skip any that aren't available — don't fail.

- \`security-pillar-reviewer\` — AWS Well-Architected: Security
- \`reliability-pillar-reviewer\` — AWS Well-Architected: Reliability
- \`performance-efficiency-pillar-reviewer\` — AWS Well-Architected: Performance Efficiency
- \`cost-optimization-pillar-reviewer\` — AWS Well-Architected: Cost Optimization
- \`operational-excellence-pillar-reviewer\` — AWS Well-Architected: Operational Excellence
- \`sustainability-pillar-reviewer\` — AWS Well-Architected: Sustainability

For each pillar reviewer, also add to their task: "If you spot a correctness bug outside your pillar, flag it anyway — don't gate on pillar-fit."

### Ad-hoc code-quality reviewers (via \`delegate_inline\`)

For each below, pass the full diff + full file contents in \`task\`. Use model "sonnet".

**Reuse reviewer — systemPrompt:**
> You review code diffs to catch duplication and missed reuse. For each newly written function, inline helper, or hand-rolled utility in the diff, search the surrounding codebase for an existing utility that already does it. Flag duplicates and suggest the existing function by file:line. Also flag hand-rolled string manipulation, manual path handling, custom env checks, or ad-hoc type guards that should use existing utilities. If you spot a correctness bug while reading, flag it too. Return a short numbered list of findings; each cites the diff hunk and the existing utility (file:line).

**Quality reviewer — systemPrompt:**
> You review code diffs for hacky patterns. Look for: redundant state; parameter sprawl; near-duplicate copy-paste blocks; leaky abstractions; stringly-typed code where constants/enums exist; unnecessary nesting; nested conditionals 3+ levels deep; unnecessary comments (what-comments, change-narration, task references — keep only non-obvious why). If you spot a correctness bug while reading, flag it too. Return a short numbered list; each cites file:line and the smell. Be specific; do not suggest stylistic preferences.

**Efficiency reviewer — systemPrompt:**
> You review code diffs for efficiency. Look for: unnecessary work (redundant computations, duplicate API calls, N+1 patterns); missed concurrency; hot-path bloat; recurring no-op updates needing change-detection guards; unnecessary existence checks (TOCTOU); unbounded memory growth; overly broad operations. If you spot a correctness bug while reading, flag it too. Return a short numbered list; each cites file:line and the inefficiency.

## Phase 3 — Aggregate

After ALL reviewers have returned, produce a single consolidated table sorted by severity (critical first). For each finding:
- **Severity**: \`critical\` | \`high\` | \`medium\` | \`low\`. **Rule: any correctness bug is \`critical\` or \`high\` — never \`medium\` or \`low\`.** Style/preference is \`low\`.
- **Source**: which reviewer raised it.
- **Location**: file:line.
- **Finding**: one sentence.
- **Effort**: \`trivial\` | \`small\` | \`medium\` | \`large\`.
- **Recommendation**: \`fix now\` | \`fix later (reason)\` | \`skip (reason — disagree with reviewer / out of scope / wrong)\`.

If two reviewers raise the same finding, merge them. Be honest about \`skip\` — reviewers are sometimes wrong. Don't argue, just note the call.

## Phase 4 — Plan

Use \`todo_write\` to create a TODO list of every \`fix now\` item, in dependency order. **All \`critical\` items must be \`fix now\` unless you have a written reason for deferring.** Skip items you marked \`fix later\` or \`skip\`.

## Phase 5 — Execute

Work the TODO list top to bottom. After each fix, mark the item done. After all items are done:
1. Re-run \`git diff\` to confirm the changes look right.
2. Briefly summarize: count fixed (broken down by severity), count deferred (with reasons), count skipped (with reasons).

If a fix turns out to be wrong mid-execution, mark it done with a note and move on — do not block the rest of the work.`;

export default function oneLastPassExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:one-last-pass", {
		description: "Deep multi-reviewer scrutiny before ship: correctness/edge-case reviewer + AWS Well-Architected pillars + code reuse/quality/efficiency, then aggregate → plan → execute.",
		handler: async () => {
			pi.sendUserMessage(PROMPT);
		},
	});
}
