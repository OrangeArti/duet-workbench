<!-- Modified from openai/codex-plugin-cc@db52e28 (Apache-2.0) by Duet Workbench; see NOTICE. -->
# Changelog

## 1.0.0 — 2026-11-16

First public version of Duet Workbench, modified from openai/codex-plugin-cc 1.0.6.

- Delegation panel in the terminal and the desktop Code tab: task types with an Auto choice, model and effort, read-only or write access, prompt preview, list of runs with result, cancel, apply and discard.
- Access is Auto by default: write for a task that asks for a change, read-only otherwise; Read-only and Write can be forced.
- A Codex thread can be continued with a tick box that can be undone, switch between read-only and write per message, and show its whole history.
- Shape prompt is off by default; with it on, a run also gets a short name made by a small Claude model.
- Runs are titled by their task, can be removed from the list, and can be handed to Claude as a reference; Claude can read all runs of the project.
- Codex limits left (session and week) as bars with percent, and tokens spent per run.
- Project mirror: `/duet:init`, `/duet:sync`, `/duet:doctor`, `/duet:remove` copy a project's Claude rules and restrictions to Codex, with a ledger so removal restores the project exactly.
- Write runs work in their own git worktree and are applied or discarded afterwards.
- Current model catalog with aliases; prompts shaped per task type.
- One job list for the panel, `/duet:delegate` and the shell; status line and a toast when a run ends.
- The shared app-server broker exits when idle.
