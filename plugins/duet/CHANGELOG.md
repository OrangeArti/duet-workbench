<!-- Modified from openai/codex-plugin-cc@db52e28 (Apache-2.0) by Duet Workbench; see NOTICE. -->
# Changelog

## 1.0.7 — 2026-11-27

- Result, History and every other output now open right under the panel header, and the panel scrolls up to them on every press. Before, the first press often only opened the output out of sight, and it showed only after you scrolled by hand.
- A long output is read on its own: while it is open the task form, the runs and the project box step aside, and **Close** brings them back. Short notices such as "Write the task first." still show above the whole panel.
- **↓ Bottom** at the top of the output and **↑ Top** at its end jump between its two ends, and **Close** sits at both ends, so a long report never needs a long scroll back.

## 1.0.6 — 2026-11-27

- Voice input for Codex tasks: dictate into Claude's own prompt box (its voice input works in the terminal and the desktop app), then press **↓ From Claude's prompt** in the panel. The text moves into the task field, after anything already typed there, and Claude's prompt box is cleared.
- Result, History and the delete confirmation now really bring the output card into view: a short card shows whole, a long one starts at the top of the view. The scroll added in 1.0.2 aimed at the card itself, which the panel cannot scroll to, so it never moved.
- The row with Send and Preview prompt wraps in a narrow panel instead of running past its frame.

## 1.0.5 — 2026-11-22

- The plugin states the Claude Code versions it works with (2.1.321 and newer), so Claude Code 2.1.323 and later will not install or load it on an older version.
- `claude plugin validate --strict` passes: the panel test now type-checks, which newer Claude Code versions check too.
- The hooks that watch Edit and Write for rule changes say outright that a failure in them lets the edit go on, so `validate` no longer lists them as unguarded.

## 1.0.4 — 2026-11-19

- Opening the panel asks Codex for its status, its model list and its limits one after the other, so a later one no longer starts a separate Codex app server while the shared one is busy. (Thanks to @emreocell, #9.)

## 1.0.3 — 2026-11-18

- A run that is still going no longer has a Result button (it could only say "still running"); its progress line shows there, and Result appears when the run ends. (Thanks to @P1LOTRX, #8.)

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
