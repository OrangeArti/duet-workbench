# Codex prompt anti-patterns (GPT-6 family)

## Carrying over habits from older models

- **Retired model names.** Names from before the GPT-6 family fail with ChatGPT sign-in. Use the aliases in `model-and-effort.md` or leave the model unset.
- **`--effort none` or `minimal` with Sol or Astra.** Not supported. Use `low`.
- **Raising effort to fix a vague prompt.** GPT-6 models reach older high-effort quality at lower effort. Add the missing "Done when" first.
- **Step-by-step process scripts.** Older Codex models rewarded detailed procedures. GPT-6 does better with the outcome, the constraints and the finish line.
- **A wall of XML blocks.** A few labelled sections are enough. Stacking a dozen contract blocks adds contradictions, and contradictions cause early stops.

## Vague framing

Bad: `Take a look at the checkout code and tell me what you think.`

Better: state the Goal ("find defects in the refund path that could double-refund"), the Context (paths), the Constraints (read-only) and the Done when (each finding has file, line, scenario).

## No finish line

Bad: `Improve test coverage.`

Better: `Done when: every exported function in src/money/ has a test for the zero, negative and overflow case, and npm test passes.`

## No autonomy line in a headless run

GPT-6 models ask for clarification more readily than earlier ones. In a delegated run nobody answers, so the run ends with a question instead of a result. Tell Codex to proceed on the most reasonable low-risk reading and to list assumptions in the report.

## Unbounded verification

Bad: `Make sure everything works.`

This invites the whole test suite, several times. Name the commands, and say when a check is not needed.

## Unspecified output

Without an output shape the report comes back long, with tables and a recap. Ask for the main point first and list the sections you want.

## Contradicting AGENTS.md

If the prompt says "skip tests" and `AGENTS.md` says "always run the suite", Codex may stop to ask. Resolve it in the prompt: say which instruction wins for this run and why.

## Repeating durable rules in every prompt

Build commands, conventions and safety rules belong in `AGENTS.md`. Codex loads it on every run; a rule buried in a long prompt is easier to lose.

## Several tasks in one run

Bad: `Fix the flaky test, also update the README, and check whether the Stripe webhook is safe.`

Three runs, three prompts. The security question in particular deserves its own read-only run.

## Restating the whole prompt on a follow-up

On `--resume-last` the thread already has the context. Send Keep / Change / Recheck only.
