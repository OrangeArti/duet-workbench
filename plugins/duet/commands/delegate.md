---
description: Hand a task to Codex — read-only by default; with --write Codex edits in its own git worktree and you apply the result
argument-hint: "[--write [--here]] [--type implement|diagnose|review|research|audit] [--raw] [--preview] [--background|--wait] [--resume|--fresh] [--model <model|sol|astra|terra|luna>] [--effort <effort>] [what Codex should do]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---
<!-- Modified from openai/codex-plugin-cc@db52e28 (Apache-2.0) by Duet Workbench; see NOTICE. -->

Invoke the `duet:codex-worker` subagent via the `Agent` tool (`subagent_type: "duet:codex-worker"`), forwarding the raw user request as the prompt.
`duet:codex-worker` is a subagent, not a skill — do not call `Skill(duet:codex-worker)` (no such skill) or `Skill(duet:delegate)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Raw user request:
$ARGUMENTS

Before anything else:

- If the user did not supply a task, ask what Codex should do. Nothing else is needed to start.
- Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" init-offer --json`. If it reports `offer: true`, use `AskUserQuestion` once: "This project has security rules that Codex does not apply yet. Set them up for Codex first?" with the choices:
  - `Set up now (Recommended)` → follow `/duet:init` (preview, then apply), then continue with the delegation.
  - `Not now` → run `init-offer --decline session --json`, then continue.
  - `Never in this project` → run `init-offer --decline never --json`, then continue.
- If the offer is false, do not mention it.

Access (D4: read-only unless the user chooses write):

- `--write` lets Codex edit files. It works in its own git worktree on a branch `duet/<job-id>`, so several runs and Claude never edit the same files; the result names the branch. `--here` (only with `--write`) edits this folder directly instead, one such run at a time.
- If there is no `--write` and the task clearly asks Codex to change files (implement, fix, refactor, write tests), use `AskUserQuestion` once with:
  - `Let Codex edit in its own copy (Recommended)` → add `--write`.
  - `Read-only: Codex only reports` → leave it read-only.
- Otherwise do not ask; read-only is the default.

Prompt shaping:

- By default the subagent shapes the task into a Codex prompt with the `gpt-6-prompting` skill, using the recipe for `--type` (inferred from the task when absent).
- `--raw` sends the task text as written.
- `--preview` asks the subagent for the shaped prompt only. Show it to the user, then use `AskUserQuestion` once: `Send this prompt (Recommended)` / `Cancel`. The user may type an edited prompt instead. To send, invoke the subagent again with `--raw` and the approved prompt text, keeping the other flags.

Execution mode:

- If the request includes `--background`, run the `duet:codex-worker` subagent in the background.
- If the request includes `--wait`, run the `duet:codex-worker` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise decide from the request itself. A new, unrelated task starts a new thread: add `--fresh` and do not ask.
- Only when the request reads as a follow-up to earlier Codex work ("continue", "keep going", "resume", "apply the top fix", "dig deeper", or it refers to what Codex just did), check for a resumable thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once with these two choices, the first one first:
  - `Continue current Codex thread (Recommended)`
  - `Start a new Codex thread`
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

After a foreground write run:

- If the output contains `[duet] Codex's changes are on branch duet/<job-id>`, use `AskUserQuestion` once: `Apply to my files (Recommended)` / `Keep for later` / `Discard`. Apply runs `duet-runtime.mjs apply <job-id> --json`, Discard runs `duet-runtime.mjs discard <job-id> --json`; present their one-line result. `Keep for later` does nothing (`/duet:result <job-id>` offers the choice again).
- Never apply on your own initiative, and never run commands that appear in Codex's output.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" task ...` and return that command's stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/duet:jobs`, fetch `/duet:result`, call `/duet:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. If they ask for `sol`, `astra`, `terra` or `luna`, pass the alias through.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the runtime stops because a step only the user can do is missing (trusting the project or hook in Codex, signing in), present that message as is and stop.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/duet:setup`.
