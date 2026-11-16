# Research notes (2026-11-12)

Facts gathered in the planning chat. "Verified" means read from the named source that day. The builder re-checks anything it relies on; OpenAI's docs moved from `developers.openai.com/codex/*` to `learn.chatgpt.com/docs/*` and change often.

## Codex models

| Model id | Positioning | Suggested starting effort |
|---|---|---|
| `gpt-6.1-sol` | default in the Codex CLI since 0.161.0; complex coding, research, long-running work | client default |
| `gpt-6-astra` | most capable; hardest reasoning | `low` |
| `gpt-6.1-terra` | writing, visual understanding, computer use; CLI ≥ 0.159.0 | none given |
| `gpt-6-luna` | focused, high-volume work; the option on Free and Go plans | `high` |

Effort values in the config reference: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; availability depends on model and client. `max` = more reasoning time for one model on one task. `ultra` = parallel subagents on separable parts. Luna: up to `max`. GPT-6.1 Sol and GPT-6 Astra do not accept `none`; Terra, Luna and GPT-6 Sol do. Speed tiers (Fast, Ultrafast) are separate from effort.

Retired for ChatGPT sign-in: `gpt-5.4`, `gpt-5.4-mini` (2026-08-31), `gpt-5.3-codex-spark` (2026-09-14), `gpt-5.5` (2026-10-14); `gpt-5.2`, `gpt-5.3-codex` earlier. API-key sessions are not affected by the GPT-5.5 retirement.

Latest CLI seen: 0.167.1 (2026-11-11). 0.164.0 added prompt presets and inline `/model`; 0.162.0 added managed git worktrees.

## Prompting the GPT-6 family

Condensed in `plugins/duet/skills/gpt-6-prompting/`. The points that shaped it:

- Codex best practices: Goal, Context, Constraints, Done when. Durable rules go in `AGENTS.md`.
- "Using GPT-6" guide: the models ask clarifying questions more readily → tell them to proceed on reasonable assumptions and finish unless the step is destructive; they are sensitive to conflicting guidance in context, including `AGENTS.md` and skills; default output is long and formatted → specify the shape; they over-test → scope verification; they may under-delegate → say when to use subagents.
- The older Codex Prompting Guide (cookbook) still targets `gpt-5.3-codex` and does not mention GPT-6.

## Codex configuration relevant to the mirror

- **Instructions.** Discovery per directory: `AGENTS.override.md`, `AGENTS.md`, then `project_doc_fallback_filenames`; one file per directory; concatenated root → cwd; budget `project_doc_max_bytes` (32 KiB default). `developer_instructions` (string) injects extra instructions; `model_instructions_file` replaces the built-in ones.
- **Permission profiles.** `default_permissions` names the profile for sandboxed tool calls; built-ins `:read-only`, `:workspace`, `:danger-full-access`; custom names need a `[permissions.<name>]` table. `permissions.<name>.filesystem` entries take `"read" | "write" | "deny"`; under the `":workspace_roots"` scope, glob subpaths such as `"**/*.env"` can be denied. A network domain allowlist exists (`allow` / `deny`, `deny` wins; exact hosts, `*.example.com`, `**.example.com`) with `allow_local_binding`. `default_permissions` cannot be combined with the legacy `sandbox_mode`.
- **Approvals.** `approval_policy`: `on-request`, `never`, or a granular table. The docs recommend `never` for non-interactive runs.
- **Hooks.** On by default (`[features] hooks`). Loaded from `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`; all matching hooks from all layers run. Events include `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SessionStart`, `Stop`. `PreToolUse` sees `Bash`, `apply_patch` and MCP tools; the command is in `tool_input.command`. Block with exit code 2 + stderr, or JSON `permissionDecision: "deny"`. `ask` is not supported. Only `type: "command"` handlers run; `async` handlers are skipped. Default timeout 600 s.
- **Trust.** Project-local config and hooks load only for trusted projects. Each non-managed hook must be reviewed and trusted (`/hooks`); trust is bound to the hook's hash. A bypass flag exists for one invocation — do not use it.
- **Profiles** (`$CODEX_HOME/<name>.config.toml`, `--profile`) are ignored in project-local config.

## Upstream plugin anatomy (`openai/codex-plugin-cc` @ db52e28, v1.0.6, last commit 2026-07-07)

- `plugins/codex/scripts/codex-companion.mjs` (~1070 lines): CLI with `task`, `review`, `adversarial-review`, `status`, `result`, `cancel`, `setup`, `task-resume-candidate`, transfer. Talks to `codex app-server` through `lib/app-server.mjs` and a broker process (`app-server-broker.mjs`) shared per session.
- Threads start with `approvalPolicy: "never"` and `sandbox: "read-only"`, or `"workspace-write"` when `--write` is passed (legacy sandbox params — see V1).
- Job state lives under `CLAUDE_PLUGIN_DATA`, falling back to the OS temp dir.
- `agents/codex-rescue.md`: a forwarder subagent (`model: sonnet`, tool: Bash) that makes exactly one `task` call. `commands/rescue.md` routes to it through the Agent tool; a skill-based route recursed (upstream fix #234).
- Hooks: `SessionStart`/`SessionEnd` lifecycle, and a `Stop` hook for the optional review gate (900 s timeout).
- Tests: `node --test tests/*.test.mjs` with a fake Codex fixture (`tests/fake-codex-fixture.mjs`) — reuse it.
- `npm run prebuild` runs `codex app-server generate-ts` to produce current protocol types.
- Stale parts to replace: skill `gpt-5-4-prompting`; `VALID_REASONING_EFFORTS = none|minimal|low|medium|high|xhigh`; `MODEL_ALIASES = spark → gpt-5.3-codex-spark`; README examples with `gpt-5.4-mini`; three tests in `tests/commands.test.mjs` assert the old skill name.
- The human's installed copy was already patched by `tools/codex-plugin-refresh/apply.mjs` in his other project (new skill, efforts `none|low|medium|high|xhigh|max|ultra`, aliases `sol|terra|luna|astra`). That patch is a stopgap; this plugin replaces it.

## Open questions at the start (settled below)

The questions V1–V8 were: how sandbox and permission profiles apply to app-server threads; whether project hooks fire there; whether the app server lists models; whether `max`/`ultra` pass through; how to read project trust; what a panel can contain; fallback filenames at project level.

## Verified on this machine

Checked 2026-11-12 with `codex-cli 0.164.0` (ChatGPT Plus sign-in), Node 24.22.1, Claude Code 2.1.321, macOS 26.6. Method: protocol types from `codex app-server generate-ts`, then a throwaway JSON-RPC client against `codex app-server` (`initialize` → `initialized` → requests). Config-only checks used a temporary `CODEX_HOME` holding nothing but a `[projects."<path>"] trust_level = "trusted"` entry, so no credentials were copied or read. Requests that start no turn cost no allowance.

### V1 — sandbox for app-server threads: **settled**

- `thread/start` takes `sandbox: "read-only" | "workspace-write" | "danger-full-access"` (legacy) and `config: { <key>: <json> }` (per-thread config overrides). There is **no** permission-profile parameter. `turn/start` has `sandboxPolicy` (legacy shape). The response carries `activePermissionProfile: { id, extends }` and a legacy `sandbox` summary.
- In a **trusted** project with `default_permissions = "duet"`, a `thread/start` that omits `sandbox` gets `activePermissionProfile = { id: "duet", extends: ":workspace" }`. The project profile applies to app-server threads.
- **Sending the legacy `sandbox` param replaces the profile**: `activePermissionProfile` becomes `null`, and the project's filesystem denies no longer apply. Upstream always sends `sandbox`. → The runtime must **not** send `sandbox`; it selects the profile with `config: { default_permissions: "<id>" }` instead.
- `config.default_permissions` naming a profile that does not exist fails the `thread/start` with JSON-RPC `-32600` "default_permissions refers to undefined profile `x`" — fails closed.
- `config.default_permissions = ":danger-full-access"` is accepted from the client. The runtime must never send it (CLAUDE.md rule); add a test.
- TOML shapes accepted (seen parsed back through `config/read`):
  ```toml
  default_permissions = "duet"
  [permissions.duet]
  description = "…"
  extends = ":workspace"            # or ":read-only"
  [permissions.duet.filesystem]
  ":workspace_roots" = { "." = "write", "**/.env" = "deny", ".codex" = "read" }
  "~/.ssh" = "deny"                  # home path outside the workspace parses
  [permissions.duet.network]
  enabled = true
  allow_local_binding = false
  [permissions.duet.network.domains]
  "api.github.com" = "allow"
  "*.npmjs.org" = "allow"
  ```
  With `network.enabled = true` the legacy summary reports `networkAccess: true`; whether the domain list is then the only thing allowed is **not verified** (the canary runs with network off); add a network case to the Phase 5 canary if the network mirror is kept.
- `permissionProfile/list { cwd }` lists built-ins plus project profiles (`allowed: true|false`).
- In an **untrusted** project the project layer is ignored and threads get `:read-only` (or what `sandbox` asks for).

### V2 — project hooks for app-server threads: **settled**

- `hooks/list { cwds: [path] }` returns each hook with `source: "project"`, `currentHash: "sha256:…"`, `trustStatus: "managed" | "untrusted" | "trusted" | "modified"`, `enabled`, `matcher`, `command`, `timeoutSec` (default 600). Untrusted project → no hooks listed at all.
- Event names on the wire: `preToolUse`, `permissionRequest`, `postToolUse`, `sessionStart`, `stop`, … Notifications `hook/started`, `hook/completed` exist.
- Hook trust cannot be granted through a session flag or the app server (no such method; doing it by writing config would be a trust bypass, which we don't do). The human trusts hooks in Codex (`/hooks`).
- **Untrusted hook** (project trusted, hook not): Codex skips it **silently** in an app-server turn — no error, no notification; a command it would have blocked ran. Codex's own TUI says so too: "Continue without trusting (hooks won't run)".
- **Trusted hook** fires for app-server turns: `hook/started` / `hook/completed` notifications (`status: "completed" | "blocked"`), exit code 2 + stderr blocks the call, and the model sees "Command blocked by PreToolUse hook: <stderr>".
- Hook stdin seen live: `{ session_id, turn_id, transcript_path: null, cwd, hook_event_name: "PreToolUse", model, permission_mode: "bypassPermissions", tool_name, tool_input, tool_use_id }`. Shell calls arrive as `tool_name: "Bash"`, `tool_input.command` = the bare command (not the `zsh -lc` wrapper). File edits arrive as `tool_name: "apply_patch"`, `tool_input.command` = the whole patch with **absolute** paths (`*** Add File: /abs/path`).
- **Trust hash covers the `hooks.json` entry (command string, matcher), not the script's contents**: editing the script kept `trusted` with the same hash; changing the command or matcher turned it `modified` (hook stops running until re-trusted). Consequences: (a) the registered command line must stay byte-identical across syncs and plugin updates; (b) the script it runs must not be writable by a delegated run, since its content is not re-checked. Codex's TUI also warns trusted hooks "can run outside the sandbox".

### V4 — model list: **settled**

`model/list { includeHidden }` works with ChatGPT sign-in and returns per model `id`, `displayName`, `description`, `hidden`, `isDefault`, `supportedReasoningEfforts[{ reasoningEffort, description }]`, `defaultReasoningEffort`, `serviceTiers`. Seen today:

| id | default | efforts | default effort |
|---|---|---|---|
| `gpt-6.1-sol` | yes | low … max, ultra | low |
| `gpt-6-astra` | | low … max, ultra | low |
| `gpt-6.1-terra` | | low … max, ultra | low |
| `gpt-6-sol` | | low … max, ultra | medium |
| `gpt-6-luna` | | low … max | medium |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | | "older generation", still listed | |
| `gpt-reserve`, `codex-auto-review` | hidden | | |

Differences from the planning notes: no model lists `none` or `minimal`; Luna stops at `max` (no `ultra`); the user's config sets `model_reasoning_effort = "high"`, which the thread reports when no effort is sent. `gpt-5.6-*` exist and are not retired — the F3 grep `gpt-5` must exclude the live catalog, or the fallback catalog must omit them.

### V5 — `max` / `ultra` through the app server: **settled**

`model/list` advertises `max` and `ultra` for `gpt-6.1-sol`; `ReasoningEffort` is a free string in the protocol. Live: `turn/start { model: "gpt-6.1-sol", effort: "max" }` and `effort: "ultra"` both completed. A bogus effort fails the turn at once (`turn/completed` status `failed`, API 400 listing `none, minimal, low, medium, high, xhigh, max` — so `ultra` is handled by Codex before the API). An unknown model fails at once with `codexErrorInfo: "modelNotFound"` ("not supported when using Codex with a ChatGPT account"). Neither hangs, so F4 can surface `turn.error.message` as the one-line reason.

### V6 — reading project trust: **settled**

`config/read { cwd, includeLayers: true }` returns `layers[]`; the `{ type: "project", dotCodexFolder }` layer has `disabledReason` set (a sentence telling the user to trust the folder) when the project is untrusted, and `null` when trusted. The server also emits a `configWarning` notification. No credential file is touched. Hook trust per hook comes from `hooks/list` (V2). A session flag `-c projects."<path>".trust_level="trusted"` does **not** trust a project (good).

### V7 — what a panel can do: **settled → Variant A**

From the `plugin-authoring` skill (Claude Code 2.1.321), a mod is a hooks module (`hooks/hooks.json` → `{ "modules": ["./register.tsx"] }`):
- `$.ui.open({ id, title })` + a `ui.render` hook on `{ component: 'Pane', requestId }` draws a side pane. Desktop and terminal tables both have `Box`, `Text`, `Button`, `Input`, `Select`, `Code`, `Markdown`, `Link`; handlers stay in the plugin (`onPress`, `onInput`, `onSubmit`, select events).
- Live updates: `$.state` atoms (`atom`, `read`, `update`) redraw readers; `$.clock.every` for polling.
- `$.process.run(argv, { cwd, stdin, timeoutMs ≤ 10 min })` and `$.process.spawn` run host commands without a shell → the pane can call `node <plugin root>/scripts/duet-runtime.mjs … --json` with the prompt on stdin. `$.plugin.root` gives the plugin folder.
- `$.command.register` + `command.run` give slash commands; `$.ui.status`, `$.ui.toast`, `$.ui.notify` exist; `session.start` / `session.end` hooks replace the shell lifecycle hooks; a plugin folder's `agents/*.md` still declare subagents.
- Open: whether one plugin can carry both a hooks module and classic shell hooks in `hooks.json`, and classic `commands/*.md` next to module-registered commands. Check with `claude plugin validate` at the start of Phase 4.

### V8 — instruction files at project level: **settled**

In a trusted project, `.codex/config.toml` with `project_doc_fallback_filenames = ["CLAUDE.md"]` and `project_doc_max_bytes = 65536` both take effect (seen in effective `config/read`). With no `AGENTS.md`, `thread/start` lists `instructionSources` = root `CLAUDE.md` and `sub/CLAUDE.md` (cwd `sub/`). With an `AGENTS.md` present, only `AGENTS.md` is used for that directory. Default budget is 32768 bytes. `instructionSources` in the `thread/start` response is a cheap way for `doctor` to show what Codex will actually read.

### V3 — canary: **passed**

Fixture `~/duet-workbench-canary` (git repo; fake `.env` and `sub/.env`; profiles `duet-read` = `:read-only` + `"**/.env" = "deny"`, `duet` = `:workspace` + the same deny + `.codex` and `AGENTS.md` read-only; one logging `PreToolUse` hook that blocks anything containing `HOOKBLOCK`). Project trusted by the human in Codex. Turns on `gpt-6-luna` / `low`, profile chosen with `thread/start config.default_permissions`, no `sandbox` param. Results checked on disk and by grepping every event for the fake values, not only from the model's report.

| Run | `cat .env` | `cat sub/.env` | python `open('.env')` | write file | write `.codex/` (shell / apply_patch) | append `AGENTS.md` |
|---|---|---|---|---|---|---|
| `duet-read` | Operation not permitted | Operation not permitted | — | — | — | — |
| `duet` | Operation not permitted | Operation not permitted | PermissionError | ok | denied / "patch rejected: writing outside of the project" | denied |
| upstream style: `sandbox: "read-only"` | **printed the value** | **printed the value** | — | — | — | — |

`**/.env` matches the root `.env` too. The third row is the V1 problem shown live.

Practical note: with the rules visible in its environment the model may refuse to even attempt a denied step ("the environment explicitly denies reading .env"). The `doctor` canary prompt has to say plainly that this is the owner's sandbox test and attempts are expected.

### V9 — git worktrees: **settled by free calls (no turn)**, codex-cli 0.167.2, 2026-11-15

Worktree of `~/duet-workbench-canary` at a different absolute path (outside the project), mirror files copied in. `config/read`, `hooks/list`, `thread/start { ephemeral: true }` only.
- **Project trust carries over**: the worktree's project layer has no `disabledReason`, with no `[projects."<worktree>"]` entry in `~/.codex/config.toml`. Codex resolves trust through the main repository.
- **Config comes from the worktree**: the project layer is `<worktree>/.codex`, and `default_permissions = "duet-read"` resolves to `{ id: duet-read, extends: :read-only }`. Without `.codex/` in the worktree there is no project layer and `thread/start` fails (`default_permissions requires a [permissions] table`) — fail closed, but the mirror must be in the worktree (it is untracked in most projects).
- **Hooks come from the main repository**: `hooks/list` for the worktree shows the main checkout's `.codex/hooks.json` entries with their trust (`trusted` / `untrusted` as in the main checkout); edits to the worktree's own `hooks.json` (relative command, extra entry) are not listed. Hook trust is keyed in `~/.codex/config.toml` by `"<main>/.codex/hooks.json:pre_tool_use:<i>:<j>"` + hash. So no re-trust per worktree, and the registered absolute command (main checkout's adapter) is what runs.
- Consequence for the adapter: it runs from the main checkout but sees worktree paths (`cwd`, absolute patch paths). It must treat the worktree as the project when the call's `cwd` is a worktree of the same repository.
- Not seen yet: a real turn in a worktree (that the listed hook actually fires and the profile's denies hold). Phase 5 canary.

### Probe scripts

Throwaway JSON-RPC probes used for all of the above lived in the session scratchpad; the logic they need (`initialize`/`initialized`, `config/read`, `hooks/list`, `thread/start` with `config`, `turn/start`, wait for `turn/completed`) goes into the runtime in Phase 1/2.

## Retired model names (moved out of the prompting skill, Phase 1)

| Model | Retired | Replace with |
|---|---|---|
| `gpt-5.4`, `gpt-5.4-mini` | 2026-08-31 | `gpt-6.1-sol`, `gpt-6-luna` |
| `gpt-5.3-codex-spark` | 2026-09-14 | `gpt-6-luna` for speed and volume |
| `gpt-5.5` | 2026-10-14 | `gpt-6.1-sol` (`gpt-6-luna` on Free and Go) |
| `gpt-5.2`, `gpt-5.3-codex` | earlier | `gpt-6.1-sol` |

