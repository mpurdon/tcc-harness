# tcc

A local coding CLI: [`pi`](https://github.com/badlogic/pi-mono) + AWS Bedrock + opt-in plugin marketplaces + persistent memory + a stack of focused extensions.

## Install

```bash
./install.sh                                  # npm link + PATH hint  (or: npm run install:global)
tcc init                                      # bootstrap ~/.tcc/ with defaults + auto-detected MCP
aws sso login --profile claude-code-bedrock   # optional — `tcc` auto-runs this on TTY when expired
tcc                                           # interactive, from any directory
tcc --print "Hello"                           # one-shot
```

Uninstall: `npm run uninstall:global`.

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
| `/tcc:budget` · `/tcc:budget override` · `/tcc:budget reset session` | Cost-budget status + control. |
| `/tcc:auth` | Same view as `tcc auth`, inside the session. |
| `/tcc:sso [profile]` | Refresh AWS SSO without leaving tcc (browser flow runs in place). Pi's built-in `/login` is for provider OAuth, hence the namespaced name. |
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
| `mcp__<server>__<tool>` | Any tool from a configured MCP server (dynamic). |

## Capabilities

### Memory

Three sources merged at startup: `~/.tcc/memory/` (global), `<repo>/.tcc/memory/` (project), `~/.claude/projects/<encoded-cwd>/memory/` (auto-imported from Claude Code). Precedence: project > claude-code > global. The MEMORY index is injected into the system prompt every turn. Format matches Claude Code's memory format exactly (frontmatter + body).

### Plugins

Cloned from whatever marketplaces are listed in `~/.tcc/config.json` into `plugins-cache/`, refreshed at most once per hour. Marketplaces are opt-in — defaults are empty, and `tcc init` offers known marketplaces interactively. A marketplace whose clone fails (auth, 404, network) is skipped with a warning; other marketplaces still load. Each plugin contributes skills (`SKILL.md` files surfaced via pi's `resources_discover`), commands (`commands/*.md` as `/<plugin>:<cmd>`), hooks (`hooks.json` wired to pi events), and MCP servers (`.mcp.json` spawned via the bridge). Cross-marketplace dedupe: first occurrence by plugin name wins. Malformed SKILL.md frontmatter is auto-rescued in-place.

### MCP

Generic stdio client. Tools registered as `mcp__<server>__<tool>`. **Lazy boot** — tool descriptors are cached at `~/.tcc/cache/mcp-tools/<server>-<hash>.json` after the first successful spawn; subsequent startups register tools from cache and only spawn the server on first invocation (~3s startup saving with multiple servers). **Auto-restart** — transport close fires exponential backoff (1s → 30s, max 5 attempts). **Shutdown** on `session_shutdown` / `SIGINT` / `SIGTERM`.

### Subagents

Discovers Claude-Code-format agent files (frontmatter `name`, `description`, `tools`, `model` + body as system prompt) from `~/.claude/agents/`, `~/.pi/agent/agents/`, and the per-repo equivalents. `delegate(agent, task)` spawns an isolated `pi --print` subprocess with the agent's system prompt and tool allowlist; `list_subagents` describes what's available. Subagent model strings (`opus`/`sonnet`/`haiku`/ARN) resolve to Bedrock ARNs from env.

### Permission gates

Block or `confirm` rules wired to `tool_call`. Defaults block `rm -rf /` (and equivalents against `/etc`, `$HOME`, `/Users/<x>`), block force-push to `main`/`master`/`prod`/`release`, and `confirm` (interactive dialog) for: other force pushes, `terraform destroy`, `kubectl delete` (no `--dry-run`), `aws iam` mutations, `DROP`/`TRUNCATE`, `curl … | sh`. Overridable at `~/.tcc/permissions.json` and `<repo>/.tcc/permissions.json`.

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
      "event": "PostBashCommand",            // or "PostToolUse" or "Stop"
      "match": "^git commit\\b",             // regex (omit for Stop)
      "onlyIfSuccess": true,                 // default true — skip on tool error
      "actions": [
        { "type": "slashCommand", "command": "/tcc:since one-last-pass" },
        { "type": "prompt",       "command": "Now write a one-line release note." },
        { "type": "shell",        "command": "say done", "timeoutMs": 5000 }
      ]
    }
  ]
}
```

Action types: `slashCommand` (auto-prepends `/`), `prompt` (free text), `shell` (with `CLAUDE_PROJECT_DIR` in env). Ready-to-copy example at `examples/hooks.json`.

### Observability

- Live footer: AWS profile, repo branch + dirty + ahead/behind + last-commit-age, model, token %, session $.
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
| `PI_CACHE_RETENTION` | Bedrock prompt-cache TTL: `long` (1h, default) or `short` (5min). |
| `AWS_BEDROCK_FORCE_CACHE=1` | Force `cache_control` on inference-profile ARNs (default on; pi-ai's heuristic wouldn't enable caching otherwise). |

## Config files

| Path | Schema |
|---|---|
| `~/.tcc/bedrock.json` | AWS profile, region, Bedrock inference-profile ARNs. Falls back to `~/.claude/trajector-settings.json` if present (legacy path). |
| `~/.tcc/config.json` | `{ marketplaces, enabledPlugins, mcpServers, budgets, measureTwice }`. |
| `~/.tcc/mcp.json` | `{ mcpServers: { name: { command, args, env } } }`. Managed via `tcc mcp`. |
| `~/.tcc/permissions.json` | `{ rules: [{ name, tool, pattern, action, message }], defaults: true }`. |
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
  "measureTwice": { "enabled": false, "model": "opus", "tools": ["write", "edit", "bash"] }
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
src/budgets.ts          session + daily budget caps + /tcc:budget
src/memory.ts           memory tools + /tcc:remember /tcc:forget + CC bridge
src/checkpoints.ts      per-repo workflow checkpoints + /tcc:since /tcc:checkpoint
src/hooks.ts            user-defined lifecycle hooks
src/permissions.ts      bash command gates + default ruleset
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
src/help.ts             /tcc reference
src/debug.ts            TCC_DEBUG event log
src/util.ts             readJson + writeJsonAtomic + loadTccConfig + runProcess + logAuthEvent + fmtDollars
src/config.ts           findGitRoot + paths + loadConfig
prompts/system.md       appended to pi's default system prompt
themes/*.json           tcc-shipped themes
plugins-cache/          gitignored — cloned marketplace repos
examples/hooks.json     drop into ~/.tcc/hooks.json for post-commit /tcc:since one-last-pass
```
