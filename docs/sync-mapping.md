# The project mirror

How `init`, `sync`, `doctor` and `remove` work. Claude-side files are the only source of truth and are never written. Codex-side files are generated.

TOML and JSON shapes below follow the Codex documentation as of 2026-11-12. Syntax marked *(verify)* must be checked against the installed CLI in Phase 0 before it is emitted.

## Sources (read-only)

| Source | Used for |
|---|---|
| `CLAUDE.md` at the project root, and nested `CLAUDE.md` files | instructions |
| `.claude/settings.json` → `permissions.deny`, `permissions.ask`, `sandbox`, `hooks.PreToolUse` | restrictions |
| hook scripts referenced by those `PreToolUse` entries, when they live inside the project | guard behaviour |

Not sources: `.claude/settings.local.json`, `CLAUDE.local.md` (personal, usually gitignored), user-level `~/.claude` settings, plugin-provided hooks. `doctor` lists them as "not mirrored (personal or external)".

## Targets (generated)

| Target | Content | Ownership marker |
|---|---|---|
| `AGENTS.md` | one managed block | `<!-- duet-workbench:begin -->` … `<!-- duet-workbench:end -->`; text outside is the user's |
| nested `AGENTS.md` | one managed block per nested `CLAUDE.md`, holding only that directory's rules: Codex reads it after the root `AGENTS.md`, which already carries parts 1–3. Directories whose name starts with a dot and `node_modules` are not searched | same |
| `.codex/config.toml` | permission profile, default profile, instruction size limit | managed regions or ledger-tracked keys (see "Editing TOML") |
| `.codex/hooks.json` | `PreToolUse` entry calling the hook adapter | entries tagged by command path; other entries untouched |
| `.duet-workbench/config.json` | per-project options (auto mode, opt-ins, exclusions) | whole file; written at `init` only. If it is deleted later the defaults apply and `sync` does not recreate it |
| `.duet-workbench/state.json` | ledger: what was created or changed, previous values, source and target hashes | whole file |
| `.duet-workbench/guard.json` | command-prefix deny list derived from `permissions.ask` and Bash denies | whole file |

Commit by default: all of the above. They contain no personal data, and a teammate or CI benefits from the same restrictions. `init` says so and offers to add them to `.gitignore` instead.

## Instructions: CLAUDE.md → AGENTS.md

Codex reads `AGENTS.override.md`, then `AGENTS.md`, then configured fallback names, one file per directory, concatenated from the repository root down, within a byte budget (32 KiB by default).

The managed block contains, in this order:

1. **Adapter preamble** (fixed text, a few lines): these rules were written for Claude Code and apply to you as well; read "Claude Code" and "you" as yourself; where a rule names a Claude-only tool or plugin, follow the intent with your own tools.
2. **Delegation contract** (fixed text): you are run as a worker by Duet Workbench; nobody can answer questions during the run; never perform the actions listed under "Needs a human"; finish with the report shape the task asks for.
3. **Needs a human** (generated from `permissions.ask` and rules that could not be enforced technically): actions to stop and report instead of performing.
4. **Project rules** (the body of `CLAUDE.md`, verbatim).

Rules:

- Verbatim copy, no model rewriting (D6). A verbatim mirror cannot drift in meaning.
- If the result exceeds the byte budget, raise `project_doc_max_bytes` in the managed config to fit, up to 64 KiB. A `project_doc_max_bytes` the project set itself is never changed; it is the ceiling instead. Beyond the ceiling, switch that file to **pointer mode**: the block holds parts 1–3 (root file only) plus an instruction to read `CLAUDE.md` before starting, and `doctor` flags it as instruction-only.
- Optional per-project exclusions (`.duet-workbench/config.json` → `excludeHeadings`) drop named sections that only make sense for Claude. Default: none.
- If V8 shows that `project_doc_fallback_filenames = ["CLAUDE.md"]` works at project level, offer **fallback mode** as an alternative for projects that do not want an `AGENTS.md` at all: Codex reads `CLAUDE.md` directly and parts 1–3 go into `developer_instructions`. Default stays the managed block, because `AGENTS.md` is also read by other tools.

## Restrictions: settings.json → Codex

Each Claude rule gets one of three outcomes, shown by `doctor`:

- **enforced** — a Codex mechanism blocks it technically;
- **instruction-only** — it appears under "Needs a human" or in the rules text, nothing blocks it;
- **not mirrored** — with the reason.

| Claude rule | Codex mechanism | Outcome |
|---|---|---|
| `permissions.deny: Read(<path or glob>)` inside the project | filesystem deny for that glob in the managed permission profile, under the workspace-roots scope, e.g. `"**/.env" = "deny"` *(verify)* | enforced |
| `permissions.deny: Read(~/...)` or absolute paths | filesystem deny for that path in the profile *(verify home expansion)* | enforced |
| `permissions.deny: Edit(<path>)` / `Write(<path>)` | path set to read-only in the profile | enforced |
| `permissions.deny: Bash(<prefix>:*)` | prefix in `guard.json`, blocked by the hook adapter | enforced if V2 passes, else instruction-only |
| `permissions.ask: Bash(<prefix>:*)` | same deny path — a delegated run cannot ask — plus an entry under "Needs a human" | enforced if V2 passes, else instruction-only |

A deny on a directory's contents (`Read(dir/**)`) also denies `dir` itself: with `dir/**` alone Codex still lists the directory, so file names would leak (seen in the canary).
| `permissions.ask` / `deny` on other tools (WebFetch, MCP…) | none | instruction-only |
| `sandbox.enabled: true` | Codex always runs sandboxed; the mirror never emits full access | enforced |
| `sandbox.network.allowedDomains` | network domain allowlist in the profile *(verify table shape)* | enforced |
| `sandbox.network.allowLocalBinding` | the matching Codex network option *(verify name)* | enforced |
| `sandbox.excludedCommands`, `allowUnsandboxedCommands` | none; Codex has no per-command sandbox escape in delegated runs | not mirrored (stricter by default) |
| `hooks.PreToolUse` with a command inside the project and a matcher that includes Bash, Edit, Write or MultiEdit | run through the hook adapter | enforced if V2 passes |
| `hooks.PreToolUse` whose command is an external binary or absolute path outside the project | none by default; opt in per hook in `.duet-workbench/config.json` | not mirrored (external) |
| `hooks.PreToolUse` matching only Read, Grep, Glob, NotebookEdit | Codex does not expose those as hookable tools; file reads are covered by filesystem denies | not mirrored (no equivalent) |
| other hook events, `enabledPlugins`, `env` | none | not mirrored |
| always added by the mirror | `.codex/`, `.duet-workbench/`, `.claude/`, `AGENTS.md` read-only for delegated runs | enforced |

The mirror only adds restrictions. If a project's own `.codex/config.toml` already has a stricter value, keep it. If it has a looser value for the same key, do not overwrite silently: `doctor` reports a conflict and `sync` asks.

## The hook adapter

`plugins/duet/scripts/hook-adapter.mjs`, registered in `.codex/hooks.json` under `PreToolUse` for `Bash` and `apply_patch`.

Codex's hook protocol is close to Claude's: JSON event on stdin with `tool_name` and `tool_input`; exit code 2 with a reason on stderr blocks the call. Differences the adapter bridges:

- **Tool names.** Codex reports file edits as `apply_patch` with the patch text in `tool_input.command`. The adapter parses the patch and synthesises one Claude-shaped event per touched file (`Write` with `file_path` and the added text as `content`), so a guard that inspects paths and written content works unchanged.
- **Environment.** It sets `CLAUDE_PROJECT_DIR` to the project root before invoking a mirrored hook.
- **`ask`.** Codex does not support a hook answering "ask". A mirrored hook that asks is treated as deny.
- **`guard.json`.** Before running mirrored hooks, the adapter checks the command against the prefix deny list and blocks with a message telling Codex to report the needed action instead.
- **Failure mode.** If the adapter itself crashes or a mirrored hook is missing, block (fail closed) and name the problem. This differs on purpose from guards that fail open: an unattended run should not continue without its guard.

Codex runs project hooks only for trusted projects, and only after each hook has been reviewed and trusted; trust is tied to the hook's hash. So the adapter's registered command must stay stable across syncs: register one fixed command line and keep everything that changes in `guard.json` and the ledger. `init` ends by telling the human how to trust it; `doctor` reports untrusted state if it can be detected (V6). Never use the trust-bypass flag.

The adapter path must survive plugin updates. Either copy the adapter into `.duet-workbench/hook-adapter.mjs` at init (stable path, hash changes only when the adapter does), or resolve the plugin path at run time. Choose after V2.

## Editing TOML and JSON safely

- Never rewrite a user's file wholesale. Insert, update or remove only managed entries.
- Top-level TOML keys must precede the first table header, so a managed region for top-level keys goes at the top of the file and a second region for tables at the end; or track managed keys in the ledger and edit structurally. Either is fine; no runtime dependency (vendor a single-file parser if needed).
- Before writing, detect a user-defined key or table that collides with a managed one and report a conflict instead of writing.
- Write atomically (temp file + rename). Keep file mode.

## Ledger and drift

`.duet-workbench/state.json` records, per target: whether the plugin created the file, the managed content hash at last sync, any previous value it replaced, and the hash of every source at last sync.

`doctor` compares:

| Check | Meaning | Fix |
|---|---|---|
| source hash changed | `CLAUDE.md`, settings or a guard script changed since last sync | reported as `changedSources`. The state is decided by the targets: it is `differences` only when the change alters a generated file, and then `sync` regenerates |
| managed target hash changed | someone edited inside a managed block or key | `sync` shows the diff and asks which side wins |
| target missing | a generated file was deleted | `sync` recreates |
| prerequisite failed | CLI too old, not signed in, project or hooks not trusted | exact steps for the human |
| coverage gap | rule is instruction-only or not mirrored | optional: Claude proposes wording for "Needs a human" (D6) |

The UI shows one chip: **In sync**, **N differences**, or **Not set up**. "Fix differences" runs `sync`.

## Remove

Preview first, then:

1. Delete the managed block from each `AGENTS.md`; delete the file if the plugin created it and nothing else remains.
2. Remove managed entries from `.codex/config.toml` and `.codex/hooks.json`, restoring previous values from the ledger; delete files and the `.codex/` directory only if empty and created by the plugin.
3. Delete the plugin's own files in `.duet-workbench/` (`state.json`, `config.json`, `guard.json`, `hook-adapter.mjs`), then the folder itself, unless it holds other files: those, and the folder, are kept and named in the preview.
4. Leave `.gitignore` lines the human accepted at init unless the ledger shows the plugin added them.

Job history lives in the plugin's data directory, not in the project, and is not touched by `remove`.

## Fixtures to build for tests

1. Empty project: `CLAUDE.md` only.
2. Rich project: deny list (project, home and absolute paths), ask list, sandbox with network allowlist, one in-project guard hook, one external-binary hook, one Read-only-matcher hook.
3. Existing Codex setup: user-written `AGENTS.md` and `.codex/config.toml` with unrelated keys and one colliding key.
4. Oversized `CLAUDE.md` (> 32 KiB and > 64 KiB).
5. Nested `CLAUDE.md` in a subdirectory.

## As built (Phase 2)

The engine is `plugins/duet/scripts/sync/engine.mjs`. Where it differs from the text above, the main differences are: two profiles `duet-read` / `duet`; TOML edited through two managed regions; the adapter is copied to `.duet-workbench/hook-adapter.mjs` and registered with matcher `*` only when there is something to guard; network mirroring is opt-in (`mirrorNetwork`).
