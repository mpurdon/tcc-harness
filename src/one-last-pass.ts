import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT = `# /one-last-pass — deep scrutiny before ship

Multi-reviewer deep scrutiny of the current changes. The primary goal is to **find bugs the author missed**, especially correctness/edge-case bugs that style-focused review tools won't catch. Secondary goal is to verify the change against AWS Well-Architected pillars and general code quality.

## Phase 1 — Establish context

1. Run \`git diff\` (or \`git diff HEAD\` if staged). If no git changes, fall back to the most recently edited files this session and treat them as the change-under-review.
2. For each touched file, **read the full file** (not just the diff hunk). Then for each new/modified function, **grep for its callers and callees** so you understand the data flow in and out.
3. In ≤3 sentences, state: what is this change supposed to accomplish? What are the invariants it must preserve? What inputs does it have to handle?
4. If the diff is empty AND nothing was edited this session, say so and stop.

## Phase 2 — Spawn reviewers in waves of 3–4 (parallel within each wave)

Do NOT fire all reviewers in one response — Bedrock throttles concurrent calls to the same inference profile, and a 10-way fan-out reliably loses several reviewers to timeout/throttle errors. Instead spawn in **waves of at most 4 tool calls per response**, suggested grouping:

- **Wave 1** (correctness is gating): the inline correctness reviewer + 3 of the named pillar reviewers.
- **Wave 2**: the remaining 3 named pillar reviewers.
- **Wave 3**: the 3 inline code-quality reviewers (reuse + quality + efficiency).
- **Wave 4**: the inline complexity/SonarQube reviewer.
- **Wave 5** (conditional — only if the diff touches Python + Strands/Bedrock/AWS SDK code): the Strands/Bedrock-specific reviewer below.

After each wave finishes, glance at the results — if a reviewer failed (timeout/throttle/non-zero exit), re-run that one as a \`delegate_inline\` call with the same systemPrompt (inline calls have proven more reliable in practice). Then continue to the next wave.

Each reviewer's \`task\` MUST include:
- The full diff
- The full contents of every changed file (NOT just the hunks — they need surrounding context)
- The intent statement you wrote in Phase 1
- A sentence directing them: "Read each changed file in full and trace the data flow before reviewing."

Without the full files, reviewers can only critique style — they can't reason about correctness.

### Strands/Bedrock SDK reviewer (Wave 5 — only if diff touches Python + Strands/Bedrock/AWS SDK)

Use \`delegate_inline\` with model "sonnet".

**systemPrompt** (verbatim):
> You are a specialist reviewer for Python code using the Strands SDK and AWS Bedrock. Your sole job is to find bugs specific to this stack — not general style issues.
>
> Check every file in the diff for these exact failure modes, in order:
>
> **1. Bedrock tool schema violations (ValidationException killers)**
> - \`list[dict]\` in any \`@tool\` function signature or Pydantic model used as \`structured_output_model\` — generates \`additionalProperties: true\`, which Bedrock rejects. Fix: use plain \`list\`.
> - \`Optional[date]\`, \`Optional[datetime]\`, or any Pydantic field that generates a \`"format"\` keyword on a union type — Bedrock rejects \`format\` on \`type: ["string", "null"]\`. Fix: use \`Optional[str]\`.
> - \`Optional[date] = None\` with Pydantic v2 can collapse to \`{"type": ["null", "null"]}\` — invalid. Fix: \`Optional[str] = None\`.
> - Any other field type that generates \`additionalProperties\`, \`$ref\`, or \`$defs\` in the tool schema — Bedrock requires fully inlined, flat schemas.
> For each violation: report file:line, the offending type, and the fix.
>
> **2. Async/event-loop traps**
> - Any \`asyncio.run()\` call inside a \`@tool\` function or any function called from a \`@tool\` — this crashes with \`RuntimeError: This event loop is already running\` when called from Strands' async event loop. Fix: use \`strands._async.run_async(coroutine_factory)\` instead.
> - Any \`await\` inside a sync \`@tool\` function — \`@tool\` functions must be sync; async work must be done via \`run_async\`.
>
> **3. Agent constructor API**
> - \`hooks=[...]\` parameter — deprecated since v1.28, should be \`plugins=[...]\`.
> - \`hook_providers=[...]\` — nonexistent kwarg, will raise TypeError at runtime.
> - \`HookRegistry.add_before_tool_call()\` or \`add_after_tool_call()\` — nonexistent methods. Correct: \`registry.add_callback(EventType, fn)\`.
>
> **4. Context window / performance bombs**
> - Any \`@tool\` that returns the full content of N documents, N parsed objects, or any payload > ~5k chars — this will be appended to every subsequent Bedrock turn, causing O(N×turns) token cost. Flag it and recommend caching the data in a module-level store and returning only a compact summary.
> - Any loop that calls \`agent.invoke_async()\` or a Bedrock API sequentially N times when N > 3 — should use \`asyncio.gather\` + \`run_async\` for parallelism.
> - Missing \`BotocoreConfig(read_timeout=...)\` on BedrockModel — default is 60s, which will timeout on agents with many tool calls.
>
> **5. Module-level state safety**
> - Module-level caches or result stores that are NOT cleared at invocation start — will cause data from invocation N to pollute invocation N+1 on warm containers.
> - \`set_shared_model()\` or equivalent injection called after \`Agent(...)\` construction — verify the agent actually picks up the model, not a stale None.
>
> **6. Local dev / OTEL**
> - Any local runner or test file that imports agent modules without first setting \`OTEL_TRACES_EXPORTER=none\` (and metrics/logs) — if \`aws-opentelemetry-distro\` is installed, this causes \`NoCredentialsError\` noise on every tool span.
>
> Format: numbered list. For each finding:
> - **Severity**: \`critical\` (will crash or produce wrong results in production) | \`high\` (will cause timeout, OOM, or severe performance degradation) | \`medium\` (correctness risk under certain conditions).
> - **Category**: schema | async | api-shape | context-bomb | state | observability.
> - **Location**: file:line.
> - **Bug**: one sentence.
> - **Fix**: one-line suggestion.
>
> Do NOT report style issues, naming preferences, or general Python best practices. Only the failure modes listed above.

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

**Complexity & SonarQube-style smells reviewer — systemPrompt:**
> You review code diffs for the kinds of issues SonarQube flags. For each new or modified function in the diff, estimate:
>
> 1. **Cyclomatic complexity** — count independent paths through the function (each \`if\`/\`else\`/\`case\`/\`&&\`/\`||\`/\`?:\`/\`catch\`/\`for\`/\`while\` adds one). Flag any function with complexity > 15 (SonarQube's default threshold).
> 2. **Cognitive complexity** — like cyclomatic but weights nesting heavier. Each level of nesting inside a conditional/loop adds its depth to the score. Flag anything > 15 (SonarQube's default threshold).
> 3. **Function length** — flag functions > ~50 lines of non-trivial code.
> 4. **Parameter count** — flag functions with > 5 parameters (suggest a single options object).
> 5. **Nesting depth** — flag control-flow nesting > 4 levels.
> 6. **Magic numbers / string literals** — flag numeric literals other than 0/1/-1 (or units like 1000, 60) and duplicated string literals (≥2 occurrences) that should be extracted to a named constant.
> 7. **Long parameter lists with similar types** — \`(a: string, b: string, c: string, d: string)\` is a type-safety hazard.
> 8. **Security hotspots** — hardcoded credentials/tokens, weak crypto (md5/sha1 for security), SQL/shell built by string concat (injection risk), \`eval\`/\`Function\` from untrusted input, missing input validation at trust boundaries, regex DoS (catastrophic backtracking patterns), unsafe deserialization.
> 9. **Type lies** — \`any\` / \`as unknown as X\` / \`@ts-ignore\` without a justifying comment, generic \`Object\` typing where a specific shape exists.
> 9b. **Unnecessary type assertions** (SonarQube S4325) — \`x as T\` or \`<T>x\` where the receiver's parameter type already accepts the expression's static type (e.g. \`logger.error('msg:', e as Error)\` when \`logger.error\` takes \`unknown[]\`; \`arr.push(item as Foo)\` when \`arr\` is \`Foo[]\` and \`item\` is already \`Foo\`). These add visual noise and silently hide future type drift. Flag and suggest deleting the assertion.
> 10. **Dead code** — unreachable branches, unused parameters/variables, commented-out blocks left behind.
>
> If MCP tools matching \`mcp__sonarqube__*\` are available, also call \`search_sonar_issues_in_projects\` and \`search_security_hotspots\` to fetch any open issues SonarQube has already flagged on the changed files — surface those alongside your own findings.
>
> Format: numbered list. For each finding:
> - **Severity**: \`critical\` (security hotspot or proven bug) | \`high\` (will likely be flagged by SonarQube quality gate) | \`medium\` (smell worth fixing) | \`low\` (preference).
> - **Type**: complexity | smell | security | dead-code | type-lie.
> - **Location**: file:line plus the function name.
> - **Finding**: one-sentence statement (e.g. "cyclomatic complexity 18 in \`processOrder\`").
> - **Fix**: one-line suggestion (e.g. "extract the validation block into a helper").
>
> Bar: only flag actual issues, not stylistic preferences. Don't flag low-complexity functions just because you could simplify them further.

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

// One-last-pass fans out to ~10 reviewers (correctness + 6 WA pillars + reuse +
// quality + efficiency + SonarQube). Each one returns a few-kB report that lands
// in main context. Plus the aggregation table, the TODO list, and the execution
// phase where the main agent reads/edits files. Empirically this eats 60–120k
// tokens of headroom in main even on a clean session.
//
// BLOCK_HEADROOM: below this, the run is almost guaranteed to overflow during
//   execution. Refuse to start; tell the user to /compact.
// WARN_HEADROOM: enough to run but tight — warn so they can /compact if they
//   were planning to keep working in this session afterward.
const BLOCK_HEADROOM = 60_000;
const WARN_HEADROOM = 120_000;

function fmtK(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
}

export default function oneLastPassExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:one-last-pass", {
		description: "Deep multi-reviewer scrutiny before ship: correctness + AWS Well-Architected pillars + code reuse/quality/efficiency + SonarQube-style complexity & smells, then aggregate → plan → execute.",
		handler: async (_args, ctx) => {
			// Refuse to fire while a turn is in flight. sendUserMessage from an
			// extension during streaming surfaces as a cryptic
			//   Extension "<runtime>" error: Cannot continue from message role: assistant
			// (or "Agent is already processing") — much friendlier to gate here.
			if (!ctx.isIdle()) {
				ctx.ui.notify(
					"/tcc:one-last-pass: agent is mid-turn — wait for the current response to finish (or hit Ctrl-C), then re-run.",
					"warning",
				);
				return;
			}

			const usage = ctx.getContextUsage();
			if (usage && usage.tokens !== null) {
				const remaining = usage.contextWindow - usage.tokens;
				const used = `${fmtK(usage.tokens)} / ${fmtK(usage.contextWindow)} (${(usage.percent ?? 0).toFixed(0)}%)`;
				if (remaining < BLOCK_HEADROOM) {
					ctx.ui.notify(
						`/tcc:one-last-pass: context too full — using ${used}, only ${fmtK(remaining)} headroom. ` +
							`Run /compact and re-run. Needs ~${fmtK(BLOCK_HEADROOM)}+ free for ~10 reviewer reports + execution.`,
						"error",
					);
					return;
				}
				if (remaining < WARN_HEADROOM) {
					ctx.ui.notify(
						`/tcc:one-last-pass: context is tight — using ${used}, ${fmtK(remaining)} headroom. ` +
							`Proceeding, but consider /compact first if you want to keep working in this session afterward.`,
						"warning",
					);
				}
			}

			pi.sendUserMessage(PROMPT);
		},
	});
}
