# tcc

A local coding CLI: [`pi`](https://github.com/badlogic/pi-mono) + AWS Bedrock + opt-in plugin marketplaces + persistent memory + a stack of focused extensions.

## Install

```bash
# Primary path — global install from the public repo
npm install -g github:mpurdon/tcc-harness

# Or — dev/local path if you've cloned this repo
./install.sh
```

Either path puts `tcc` on your PATH. The wrapper resolves `pi` (the underlying agent) from the same `node_modules` it was installed into.

After installing, follow [First-run](#first-run) before launching tcc — you need AWS SSO configured and three Bedrock inference-profile ARNs.

## First-run

tcc needs four things before it can launch: the `pi` CLI, an AWS SSO profile with Bedrock access, three Bedrock inference-profile ARNs (one each for Claude Sonnet/Opus/Haiku), and `~/.tcc/bedrock.json` pointing at all of them.

### 1. Install `pi` globally

```bash
npm install -g @earendil-works/pi-coding-agent
```

`tcc` is a wrapper around pi; pi must be on your PATH. (Skip this if `which pi` already returns a path.)

### 2. Enable Bedrock + Claude model access in your AWS account

In the AWS console:

1. Go to **Bedrock → Model access** in the region you want to use (e.g. `us-east-2`).
2. Request access to the **Anthropic Claude** family (Sonnet, Opus, Haiku). Approval is usually instant.

### 3. Create three application inference profiles

You need one inference profile per Claude tier so you can switch between Sonnet / Opus / Haiku at runtime. Easiest path is the AWS console:

1. **Bedrock → Cross-region inference → Application inference profiles → Create**
2. Pick the Claude model (e.g. Sonnet 4.6), give it a friendly name (e.g. `sonnet`), accept defaults.
3. Repeat for Opus and Haiku.
4. Copy each profile's ARN — looks like `arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/abc123`.

### 4. Set up the AWS SSO profile

If you already have a working AWS SSO profile, note its name and skip to step 5. Otherwise:

```bash
aws configure sso
# Follow the prompts; pick a profile name like `claude-code-bedrock`.
# Choose the region from step 2.
```

Verify:

```bash
aws sso login --profile claude-code-bedrock
aws sts get-caller-identity --profile claude-code-bedrock
```

### 5. Run `tcc init`

```bash
tcc init
```

The interactive prompts will offer plugin marketplaces (skip with `n` if you don't have any), then ask for the AWS profile name + region and write a template `~/.tcc/bedrock.json` with placeholder ARNs.

### 6. Fill in the real ARNs

Open `~/.tcc/bedrock.json` and replace the three placeholder `arn:aws:bedrock:...` values under `env` with the ARNs you copied in step 3. Delete the `_setup` comment when done.

### 7. Verify

```bash
tcc doctor              # checks all prerequisites
tcc doctor --deep       # also makes a real Bedrock API call to verify reachability
```

If everything is green:

```bash
tcc                     # interactive
tcc --print "hello"     # one-shot
```

Uninstall: `npm uninstall -g tcc-harness` (npm install path) or `npm run uninstall:global` (local install path).

## Tips

A few things worth knowing before you're deep in a session.

**Run `tcc doctor --deep` after your first install.** The non-deep run only checks file presence and on-disk shape; `--deep` makes a real Bedrock API call so IAM gaps and inference-profile misconfigurations surface immediately instead of failing on your first real prompt.

**Check `/tcc:cost` mid-session to confirm caching is engaged.** Look for `cacheRead` rising and `cacheWrite` flat after the first turn. If `cacheRead` stays at 0, prompt caching isn't hitting — usually a TCC_DEFAULT_MODEL override or a non-cached system prompt change. A normal 10-turn session reads back ~80% of the system-prompt input cost as cached.

**Use natural language with `watch_pr` / `watch_run` instead of memorizing flags.** "Watch PR 1234 and tell me when CI passes" or "let me know if anyone comments on PR 1234" both work — the agent calls the right tool. The slash command `/tcc:watch` is there for muscle memory; the natural-language path is usually less friction.

**Run `/tcc:retro` at the end of a productive session.** It asks the agent to propose 0–3 memories worth keeping (user preferences, project quirks, feedback patterns). Lower friction than remembering to `/tcc:remember` as you go, and the agent has the full session context.

**Use `/tcc:one-last-pass` before opening a PR.** Spawns 10 reviewers in parallel (correctness + 6 AWS Well-Architected pillars + reuse + quality + efficiency + SonarQube-style complexity) against the current diff, aggregates findings by severity, and executes the high-confidence fixes. Catches what SonarQube would flag *before* you push.

**Turn on `/tcc:mt` for high-stakes work.** Measure-twice mode reviews each `write` / `edit` / `bash` / `delegate` with a second model before it runs. Costs an extra round-trip per gated tool call, but catches complexity violations and silent mistakes the main agent might not flag. `/tcc:mt log` shows the audit trail.

**Bare slash commands open pickers.** `/tcc:theme`, `/tcc:plugin`, `/tcc:permission`, `/tcc:mcp`, `/tcc:mt tools`, `/tcc:mt model` — typing the command with no args opens an interactive checklist or selector. No need to memorize plugin IDs or rule names.

**Per-repo overrides live at `<repo>/.tcc/`.** Memory, hooks, permissions, checkpoints — drop a `.tcc/permissions.json` (or whichever) in any repo to layer rules on top of the global config without polluting `~/.tcc/`.

## Subcommands

| | |
|---|---|
| `tcc init` | Bootstrap `~/.tcc/config.json` + `~/.tcc/mcp.json` (auto-detects gh, filesystem, optional notion/jira). TTY-only: offer to wire `TCC_DEFAULT_THEME` into your shell rc. |
| `tcc update` | `git pull` + `npm install` in `$TCC_HOME`. |
| `tcc login [profile]` | Refresh AWS SSO session for the Bedrock profile (defaults to `claude-code-bedrock`). |
| `tcc auth` | Print AWS SSO auth history + lifetime stats (frequency, day-of-week, distribution). |
| `tcc mcp list \| catalog \| show <name> \| add <name> \| remove <name>` | Manage `~/.tcc/mcp.json` against a built-in catalog (github, filesystem, notion, jira, linear, slack, sentry). |

## Slash commands (inside a session)

| | |
|---|---|
| `/tcc` | This reference. |
| `/tcc:cost` · `/tcc:usage` | Session cost / token breakdown by model. |
| `/tcc:context` | Context-window usage: total vs window, static system prompt vs conversation, and the largest TCC-injected static contributors (diagnose a bloated cached prompt). |
| `/tcc:budget` · `/tcc:budget override` · `/tcc:budget reset session` | Cost-budget status + control. |
| `/tcc:auth` | Same view as `tcc auth`, inside the session. |
| `/tcc:sso [profile]` | Refresh AWS SSO without leaving tcc (browser flow runs in place). Pi's built-in `/login` is for provider OAuth, hence the namespaced name. |
| `/tcc:recap` | Regenerate the session recap now. Auto-triggers after ~3 min idle or on resume; shown above the prompt. |
| `/tcc:reload [--plugins]` | Reload extensions / skills / prompts / themes without restarting (picks up local SKILL.md + command edits). `--plugins` also busts the marketplace fetch cache so plugins re-pull from upstream. |
| `/tcc:remember <text>` · `/tcc:forget <name>` | Save / delete a memory. |
| `/tcc:checkpoint [name [set]]` | List, show, or mark workflow checkpoints. |
| `/tcc:since <workflow>` | Re-run a workflow (e.g. `/tcc:since one-last-pass`) against changes since its last checkpoint. |
| `/tcc:one-last-pass` | Deep scrutiny before ship: a dedicated correctness/edge-case reviewer + 6 AWS Well-Architected pillar reviewers + code reuse / quality / efficiency → aggregate → plan → execute valuable findings. |
| `/tcc:onboard` | Scan this repo, write `AGENTS.md`, save 1–3 project memories. |
| `/tcc:retro` | Ask the agent to propose 0–3 memories worth keeping from this session. |
| `/tcc:snapshot [slug]` | Snapshot the current session to HTML at `~/.tcc/shares/` (pi's `/share` and `/export` both have different semantics). |
| `/tcc:mt on \| off \| status \| model <name> \| tools <list> \| log [N] \| stats` | Toggle measure-twice mode; `log`/`stats` audit prior reviews. |
| `/tcc` | Reference card for all tcc commands (only un-prefixed tcc command). |

Plus all plugin commands as `/<plugin>:<command>` (e.g. `/employee-portal-plugin:build-ui`).

## LLM-callable tools (tcc-specific)

| | |
|---|---|
| `search_text` | ripgrep wrapper — smart-case, respects `.gitignore`, capped output. |
| `find_files` | fd wrapper — type/extension/hidden filters. |
| `git_diff_preview` | `git diff` with per-file truncation (default 6KB/file, 32KB total). |
| `screenshot` | macOS `screencapture` → image input (full / selection / window, optional delay). |
| `memory_save / _recall / _search / _list / _forget` | Persistent memory CRUD. |
| `checkpoint_get / checkpoint_set` | Per-repo workflow checkpoints. |
| `delegate / list_subagents` | Spawn a Claude-Code-style subagent in an isolated context (discovered from `~/.claude/agents/`, `~/.pi/agent/agents/`, and per-repo equivalents). |
| `mcp__<server>__<tool>` | Any tool from a configured MCP server (dynamic). Plus `…__list_resources` / `…__read_resource` for servers exposing resources. |

## Capabilities

### Memory

Three sources merged at startup: `~/.tcc/memory/` (global), `<repo>/.tcc/memory/` (project), `~/.claude/projects/<encoded-cwd>/memory/` (auto-imported from Claude Code). Precedence: project > claude-code > global. The MEMORY index is injected into the system prompt every turn. Format matches Claude Code's memory format exactly (frontmatter + body).

### Plugins

Cloned from whatever marketplaces are listed in `~/.tcc/config.json` into `plugins-cache/`, refreshed at most once per hour. Marketplaces are opt-in — defaults are empty, and `tcc init` offers known marketplaces interactively. A marketplace whose clone fails (auth, 404, network) is skipped with a warning; other marketplaces still load. Each plugin contributes skills (`SKILL.md` files surfaced via pi's `resources_discover`), commands (`commands/*.md` as `/<plugin>:<cmd>`), hooks (`hooks.json` wired to pi events), and MCP servers (`.mcp.json` spawned via the bridge). Cross-marketplace dedupe: first occurrence by plugin name wins. Malformed SKILL.md frontmatter is auto-rescued in-place.

### MCP

Generic stdio client. **Tools** registered as `mcp__<server>__<tool>`. **Prompts** become slash commands `/mcp__<server>__<prompt>` (positional, whitespace-separated args; the last declared arg soaks up trailing tokens) — matching Claude Code's naming. **Resources** are surfaced as two tools per server that advertises them: `mcp__<server>__list_resources` and `mcp__<server>__read_resource(uri)` (URI-addressed resources don't fit pi's file-path resource discovery, so they're exposed as callable tools instead of `@`-mentions). **Lazy boot** — tools/prompts/resources are cached at `~/.tcc/cache/mcp-tools/<server>-<hash>.json` after the first successful spawn; subsequent startups register everything from cache and only spawn the server on first invocation (~3s startup saving with multiple servers; legacy tools-only caches upgrade transparently). **Auto-restart** — transport close fires exponential backoff (1s → 30s, max 5 attempts). **Shutdown** on `session_shutdown` / `SIGINT` / `SIGTERM`. **Deferred tools** (opt-in via `TCC_MCP_DEFER_TOOLS=1` or `config.json` `mcp.deferTools`) — keeps every `mcp__*` tool registered but removes it from the active set at session start, so its schema doesn't cost context/cache each turn; the agent calls `mcp_find_tools("<keywords>")` to re-activate the ones it needs (Claude Code's ToolSearch deferral). `mcp.deferThreshold` only defers once that many MCP tools are registered.

### Subagents

Discovers Claude-Code-format agent files (frontmatter `name`, `description`, `tools`, `model` + body as system prompt) from `~/.claude/agents/`, `~/.pi/agent/agents/`, and the per-repo equivalents. `delegate(agent, task)` spawns an isolated `pi --print` subprocess with the agent's system prompt and tool allowlist; `list_subagents` describes what's available. Subagent model strings (`opus`/`sonnet`/`haiku`/ARN) resolve to Bedrock ARNs from env.

### Permission gates

Block or `confirm` rules wired to `tool_call`. Defaults block `rm -rf /` (and equivalents against `/etc`, `$HOME`, `/Users/<x>`), block force-push to `main`/`master`/`prod`/`release`, and `confirm` (interactive dialog) for: other force pushes, `terraform destroy`, `kubectl delete` (no `--dry-run`), `aws iam` mutations, `DROP`/`TRUNCATE`, `curl … | sh`. Overridable at `~/.tcc/permissions.json` and `<repo>/.tcc/permissions.json`.

### Recap

A rolling "where are we" narrative rendered as a dim line **above the prompt** — e.g. *"※ recap: Shipped v0.18.0 (calendar linking, AI truncation salvage), then ran cleanup + code review fixing 5 findings now uncommitted. Next: decide whether to commit as v0.18.1 and watch CI."* Matches Claude Code's recap feature exactly:

- **On by default.** Disable with `recap.enabled: false` in `config.json` or `TCC_RECAP=0`.
- **Auto-triggers** after ~3 minutes idle since the last turn (background generation, ready when you return), and immediately on **session resume/fork** (the "catch me up" moment).
- **Minimum 3 turns** before the first recap; never shown twice in a row without a new turn in between.
- **`/tcc:recap`** forces immediate regeneration, bypassing the idle/resume guards.
- Generated by **Haiku** (override with `recap.model`) via `pi --print` — runs out-of-band, never touches the main context window. Failures are swallowed silently.

### Network egress

Best-effort outbound-URL policy, configured under an `egress` key in `~/.tcc/permissions.json` (and per-repo `<repo>/.tcc/permissions.json`):

```json
{
  "egress": {
    "mode": "deny",
    "allowedDomains": ["github.com", "*.amazonaws.com"],
    "deniedDomains": ["pastebin.com"]
  }
}
```

`mode`: `off` (default — no enforcement), `deny` (block listed `deniedDomains`, allow the rest), or `allow` (only `allowedDomains` pass; `deniedDomains` still blocked — deny wins). Domain entries match the apex **and** subdomains (`github.com` covers `api.github.com`; a leading `*.` is optional). Enforced at two points: the `tool_call` gate scans `bash` commands and tool inputs for `http(s)` URLs, and the `research` tool checks each content-fetch target. This is a guardrail, **not** a kernel sandbox — it only gates URLs it can see in plain text, so it stops accidental/unwanted egress, not a determined adversary. Reuses the permission-rule precedence (project over global) and reloads on session start.

### Cost budgets

Session + daily caps with mode `"warn" | "pause"` (default `pause`). Warnings at 80/90/95% via `ui.notify`. At 100%, the next user input is intercepted with a pause message; `/tcc:budget override` releases the lock for the rest of the session. Daily totals persisted to `~/.tcc/daily/<YYYY-MM-DD>.json` and survive across sessions. Midnight rollover handled.

### Measure-twice

Opt-in second-opinion mode. For each `tool_call` in the gated set (default: `write`/`edit`/`bash`/`delegate`), spawn `pi --print --no-tools` with a reviewer model (`"same"` / `sonnet` / `opus` / `haiku` / ARN) holding the action under review. Reviewer responds `APPROVE` or `BLOCK: <reason>`. BLOCK returns to pi as a tool-call block; the main agent sees the reason and can adapt. Toggle via `/tcc:mt` or `TCC_MEASURE_TWICE=1`. Failure modes (reviewer crash, timeout, ambiguous response) fail open with a log line.

### Hooks

User-defined lifecycle hooks at `~/.tcc/hooks.json` and `<repo>/.tcc/hooks.json` (merged).

```jsonc
{
  "hooks": [
    {
      "event": "PostBashCommand",            // see event list below
      "match": "^git commit\\b",             // regex; meaning depends on event
      "onlyIfSuccess": true,                 // default true — skip on tool error (Post* only)
      "actions": [
        { "type": "slashCommand", "command": "/tcc:since one-last-pass" },
        { "type": "prompt",       "command": "Now write a one-line release note." },
        { "type": "shell",        "command": "say done", "timeoutMs": 5000 }
      ]
    }
  ]
}
```

Events (named to match Claude Code, so a CC `hooks.json` mostly drops in):

| `event` | Fires on | `match` tests |
|---|---|---|
| `SessionStart` | session begins/resumes | — |
| `SessionEnd` | session shuts down | — |
| `UserPromptSubmit` | you submit a prompt (interactive/rpc; hook-injected input is ignored) | prompt text |
| `PreToolUse` | before a tool runs — a `shell` action that exits non-zero **blocks** the call (its stderr becomes the reason the agent sees) | tool name |
| `PostToolUse` | after a tool succeeds | tool name |
| `PostBashCommand` | after a bash tool call | bash command |
| `PreCompact` / `PostCompact` | around context compaction | — |
| `Stop` | agent finishes a turn | — |

Action types: `slashCommand` (auto-prepends `/`), `prompt` (free text), `shell` (with `CLAUDE_PROJECT_DIR` in env). For `PreToolUse`, only `shell` actions gate execution; `slashCommand`/`prompt` queue as follow-ups. Ready-to-copy example at `examples/hooks.json`.

### Observability

- Live footer: AWS profile, repo branch + dirty + ahead/behind + last-commit-age, model, token %, session $.
- Custom status segment: set `statusLine.command` in `config.json` (or `TCC_STATUSLINE_CMD`) to a shell command whose first stdout line is appended to the footer. Refreshes on each turn end and every `statusLine.intervalMs` (min 2s, default 10s). The command gets `TCC_SL_CWD` / `TCC_SL_MODEL` / `TCC_SL_AWS_PROFILE` / `TCC_SL_DOLLARS` in its env.
- `/tcc:cost` / `/tcc:usage` — per-model breakdown using pi-ai's pre-computed cost.
- `/tcc:auth` / `tcc auth` — login frequency, session lifetimes, day-of-week histogram.
- `TCC_DEBUG=1` — append JSONL of session_start, model_select, before_agent_start, turn_start/end, tool_call, tool_result, agent_end, session_shutdown to `~/.tcc/debug/<session-id>.log`.

### Repo awareness

- Pre-flight banner at session_start: `[tcc repo] main · 3↑ 1↓ · 4 dirty · last commit 2h ago`.
- `TODO.md` / `TODOS.md` / `BACKLOG.md` at the git root auto-injected into the system prompt (first 60 lines).
- Pi's built-in walk of `AGENTS.md` / `CLAUDE.md` parent chain (unchanged).

### Auto-update

Pi ships frequent patch releases. The wrapper runs `npm view @earendil-works/pi-coding-agent version` at most once per 6h (cached at `~/.tcc/.pi-update-check`), compares against the installed version, and if it's a same-major.minor higher patch, runs `npm install -g …@<latest>` and re-execs tcc with your original args. Skipped in `--print` mode (no startup delay for scripted use), opt out with `TCC_AUTO_UPDATE_PI=0`. Network failures and minor/major version bumps are silent no-ops.

### Prompt caching

Pi-ai inserts Bedrock `cachePoint` blocks on the system prompt and the last user message; tcc forces this on for our inference-profile ARNs (`AWS_BEDROCK_FORCE_CACHE=1`) and uses the 1-hour TTL (`PI_CACHE_RETENTION=long`). First turn writes the cache (~1.25x normal input cost for the cached portion); turns 2+ within the TTL read it back at 0.1x. For a typical 10-turn session that's roughly an 80% reduction in the per-turn system-prompt cost. Visible in `/tcc:cost` and the debug log as `cacheRead` / `cacheWrite`.

### Themes

`tokyo-night`, `catppuccin-mocha`, `gruvbox-dark` (plus pi's built-in `dark` / `light`). Pick at startup with `TCC_DEFAULT_THEME=<name>`; switch live with `/theme`.

## Env vars

| | |
|---|---|
| `TCC_HOME` | Repo root (auto-detected from `bin/tcc` path). |
| `TCC_DEFAULT_MODEL` | Override default Bedrock ARN. |
| `TCC_DEFAULT_THEME` | `tokyo-night` \| `catppuccin-mocha` \| `gruvbox-dark` \| `dark` \| `light`. |
| `TCC_SKIP_SSO=1` | Skip the wrapper's SSO pre-flight. |
| `TCC_AUTO_LOGIN=0` | Disable wrapper auto-running `aws sso login` on expiry. |
| `TCC_AUTO_UPDATE_PI=0` | Disable patch-only auto-update of pi. Default: enabled, 6h cache, blocks once then re-execs. |
| `TCC_DEBUG=1` | Write per-event JSONL to `~/.tcc/debug/<session>.log`. |
| `TCC_MEASURE_TWICE=1` | Enable measure-twice mode. |
| `TCC_MCP_DEFER_TOOLS=1` | Defer MCP tool schemas out of the active tool list (agent re-activates on demand via `mcp_find_tools`). Saves context/cache with many MCP servers. Also settable via `config.json` `mcp.deferTools`. |
| `TCC_STATUSLINE_CMD` | Shell command whose first stdout line is appended to the footer as a custom segment. Also settable via `config.json` `statusLine.command`. |
| `PI_CACHE_RETENTION` | Bedrock prompt-cache TTL: `long` (1h, default) or `short` (5min). |
| `AWS_BEDROCK_FORCE_CACHE=1` | Force `cache_control` on inference-profile ARNs (default on; pi-ai's heuristic wouldn't enable caching otherwise). |

## Config files

| Path | Schema |
|---|---|
| `~/.tcc/bedrock.json` | AWS profile, region, Bedrock inference-profile ARNs. Falls back to `~/.claude/trajector-settings.json` if present (legacy path). |
| `~/.tcc/config.json` | `{ marketplaces, enabledPlugins, mcpServers, budgets, measureTwice }`. |
| `~/.tcc/mcp.json` | `{ mcpServers: { name: { command, args, env } } }`. Managed via `tcc mcp`. |
| `~/.tcc/permissions.json` | `{ rules: [{ name, tool, pattern, action, message }], defaults: true, egress: { mode, allowedDomains, deniedDomains } }`. |
| `~/.tcc/hooks.json` | See [Hooks](#hooks). |
| `<repo>/.tcc/{memory,checkpoints,hooks,permissions}.json` | Same shapes, per-project (override global on collision). |
| `~/.tcc/memory/*.md` | Global memories. |
| `~/.tcc/daily/<date>.json` | Daily cost rollup. |
| `~/.tcc/auth-log.jsonl` | SSO event log. |
| `~/.tcc/debug/<session-id>.log` | TCC_DEBUG output. |
| `~/.tcc/sessions/` | Pi session JSONLs. |
| `~/.tcc/shares/*.html` | `/tcc:snapshot` outputs. |
| `~/.tcc/mt-log.jsonl` | Measure-twice review audit log (`/tcc:mt log` / `/tcc:mt stats`). |
| `~/.tcc/cache/mcp-tools/*.json` | MCP tool descriptor cache (lazy boot). |

### Example `~/.tcc/config.json`

```json
{
  "marketplaces": [
    { "name": "my-marketplace", "repo": "owner/repo" }
  ],
  "enabledPlugins": {
    "some-plugin@my-marketplace": false
  },
  "budgets": { "session": 5.00, "daily": 25.00, "mode": "pause" },
  "measureTwice": { "enabled": false, "model": "opus", "tools": ["write", "edit", "bash"] },
  "mcp": { "deferTools": false, "deferThreshold": 1 },
  "statusLine": { "command": "echo \"⎈ $(kubectl config current-context 2>/dev/null)\"", "intervalMs": 10000 }
}
```

## Plugin format

Standard Claude Code plugin layout (consumed unchanged):

```
plugins/<name>/
├── .claude-plugin/plugin.json
├── skills/<skill>/SKILL.md
├── commands/<cmd>.md       # frontmatter + body with $ARGUMENTS
├── hooks/hooks.json        # PreToolUse / PostToolUse / UserPromptSubmit / Stop
└── .mcp.json               # mcpServers
```

## Layout

```
bin/tcc                 bash wrapper — env, subcommand dispatch, SSO preflight
scripts/init.mjs        tcc init wizard
scripts/mcp.mjs         tcc mcp subcommand
scripts/auth-stats.mjs  tcc auth stats engine
scripts/lib/            shared which + mcp-catalog for the .mjs scripts
src/extension.ts        pi extension entrypoint — composes everything below
src/bedrock.ts          register Bedrock provider with friendly model names
src/usage.ts            cost / token tracking + /tcc:cost /tcc:usage commands
src/context.ts          /tcc:context — context-window breakdown
src/recap.ts            /tcc:recap — rolling session recap widget above the prompt
src/reload.ts           /tcc:reload — hot-reload extensions/skills/plugins
src/budgets.ts          session + daily budget caps + /tcc:budget
src/memory.ts           memory tools + /tcc:remember /tcc:forget + CC bridge
src/checkpoints.ts      per-repo workflow checkpoints + /tcc:since /tcc:checkpoint
src/hooks.ts            user-defined lifecycle hooks
src/permissions.ts      bash command gates + default ruleset
src/egress.ts           network egress allow/deny policy (bash + tools + research)
src/cli-tools.ts        search_text + find_files + shell-conventions guidance
src/git-tools.ts        git_diff_preview tool
src/screenshot.ts       macOS screencapture tool (darwin-only)
src/subagents.ts        delegate / list_subagents tools
src/measure-twice.ts    second-model review of gated tool calls + /tcc:mt
src/plugins.ts          marketplace loader + plugin adapters
src/mcp.ts              MCP bridge — lazy boot, auto-restart
src/repo-status.ts      session-start git banner
src/todo.ts             TODO.md auto-load
src/login.ts            /tcc:sso mid-session SSO refresh (pi has its own /login for OAuth)
src/auth-stats.ts       /tcc:auth slash command
src/onboard.ts          /tcc:onboard prompt template
src/retro.ts            /tcc:retro prompt template
src/share.ts            /tcc:snapshot session HTML export (pi owns /share + /export)
src/theme.ts            apply TCC_DEFAULT_THEME on session start
src/statusline.ts       user-defined custom footer segment (shell command)
src/help.ts             /tcc reference
src/debug.ts            TCC_DEBUG event log
src/util.ts             readJson + writeJsonAtomic + loadTccConfig + runProcess + logAuthEvent + fmtDollars
src/config.ts           findGitRoot + paths + loadConfig
prompts/system.md       appended to pi's default system prompt
themes/*.json           tcc-shipped themes
plugins-cache/          gitignored — cloned marketplace repos
examples/hooks.json     drop into ~/.tcc/hooks.json for post-commit /tcc:since one-last-pass
```
