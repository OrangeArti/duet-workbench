# Codex prompt recipes (GPT-6 family)

Copy the smallest recipe that fits, fill the brackets, delete lines you do not need. In `duet:codex-worker`, diagnosis and fix recipes run write-capable unless the user asked for read-only.

## Diagnosis

```text
Goal: Find why [command or test] fails in this repository. I need the root cause, not a fix yet.

Context: The failure is [error text or log path]. It started after [change, if known]. Relevant code is probably under [paths].

Constraints: Read-only. Do not edit files or install packages.

Done when: You can name the root cause and point to the lines and the evidence that support it.

Work without asking me questions. If something is unclear, take the most reasonable low-risk reading and say which reading you took.

Report back with: 1) root cause, 2) evidence (files, lines, command output), 3) smallest safe next step, 4) what you could not confirm. Mark hypotheses as hypotheses. Lead with the root cause; no closing summary.
```

## Narrow fix

```text
Goal: Fix [bug] so that [observable behaviour].

Context: Root cause is [finding, or "unknown; diagnose first"]. Start in [paths]. Reproduce with [command].

Constraints: Smallest change that fixes it. Keep behaviour outside the failing path. No unrelated refactors, renames or dependency changes. Do not touch [protected paths].

Done when: [command] passes and [reproduction] no longer fails.

Carry the work through to completion without asking me questions; state any assumptions in the report. Stop and report instead of acting if the fix would need a destructive or irreversible step.

Verification: run [specific test command] once after the change; rerun only if you change code again. Do not run the full suite.

Report back with: what changed and why, touched files, checks run with their result, remaining risks.
```

## Feature or larger implementation

```text
Goal: Implement [feature]. A user should be able to [outcome].

Context: Follow the patterns in [existing files]. The spec is [path or inline bullets]. Entry points: [paths].

Constraints: Stay inside [directories]. Follow the conventions in AGENTS.md. Validate inputs at boundaries. No new dependencies without saying so in the report.

Done when: [acceptance checks: commands, behaviours, tests that must exist and pass].

Work autonomously to completion. Make reasonable assumptions and list them. Stop before anything destructive or irreversible.

Verification: add tests for [risky logic]; run [typecheck and test commands].

Report back with: summary, touched files, tests added, checks run, assumptions, open questions.
```

## Review of local changes

Prefer the built-in `review` or `adversarial-review` commands; they already carry a review contract. Use this only for a custom review.

```text
Goal: Review [diff, branch or files] for defects that would matter in production.

Context: The change is meant to [intent]. Risky areas: [auth, money, concurrency, migrations].

Constraints: Read-only. Report findings; do not fix anything.

Done when: Every finding has a file, a line and a concrete failure scenario.

After the first plausible issue, also check empty states, retries, stale state and rollback paths.

Report back with findings ordered by severity, each with file:line, the scenario that triggers it and a suggested fix. Separate confirmed defects from suspicions. If there are no findings, say so and name the residual risk in one line.
```

## Research or recommendation

```text
Goal: Recommend [decision] for [situation].

Context: Options under consideration: [list]. Constraints that matter: [budget, stack, deadlines]. Existing code and docs: [paths].

Constraints: Read-only. Prefer primary sources and what is in the repository; say when something comes from general knowledge.

Done when: The recommendation names one option, the reasons, and what would change the answer.

Report back with: recommendation first, then observed facts, then inferences, then open questions. Keep it under [length].
```

## Parallel audit (ultra effort or multi-agent)

```text
Goal: Audit [system] across these independent areas: [A], [B], [C].

Context: [paths per area].

Constraints: Read-only. Each area is examined on its own; do not let one area's conclusion steer another.

Delegation: run one subagent per area in parallel. Merge the results yourself and remove duplicates.

Done when: Each area has findings or an explicit "nothing found" with what was checked.

Report back with one section per area, then a merged priority list.
```

## Follow-up on the same thread

Use with `task --resume-last`. Send only the delta.

```text
Keep: [what must stay as it is].
Change: [the specific part and the expected result].
Recheck: [the command or behaviour to verify again].
```
