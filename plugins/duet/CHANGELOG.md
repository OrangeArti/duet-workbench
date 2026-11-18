<!-- Modified from openai/codex-plugin-cc@db52e28 (Apache-2.0) by Duet Workbench; see NOTICE. -->
# Changelog

## Unreleased

- A run that is still going no longer has a Result button (it could only say "still running"); its progress line shows there, and Result appears when the run ends.

## 1.0.2 — 2026-11-18

- Result scrolls the panel so a short output shows whole, and a long one (such as History) starts at the top of the view; before, only its first line showed.
- The panel no longer says "not signed in" while Codex is busy with a run or another panel call; a busy shared runtime is now checked directly.
- Result on a run that is still going says so, instead of "No job found".
- README: a demo GIF and a comparison with the official Codex plugin.

## 1.0.1 — 2026-11-18

- The logo shows in the desktop app (panel header, the band above the prompt, the minimized panel); only the terminal drew it before.
- The `Duet Workbench` button above the prompt stays next to the logo; it no longer jumps between the left and right edge as runs start and finish.
- The Codex runs list folds to its header line, which still shows how many runs are going.
- `/duet:remove` deletes only the plugin's own files in `.duet-workbench/` and keeps anything else a person put there.
- Reviews no longer copy untracked credential files (`.env*`, keys, `auth.json`, …) or symlinks out of the repository into Codex's prompt.
- More tests: competing rules on one path, shell metacharacters in a task, applies that conflict or meet uncommitted files.
- README: panel screenshot and how to update.

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
