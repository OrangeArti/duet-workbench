---
name: gpt-6-prompting
description: Internal guidance for composing Codex prompts for the GPT-6 model family (GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Luna, GPT-6 Astra) and for choosing model and reasoning effort inside the Codex Claude Code plugin
user-invocable: false
---

# GPT-6 Prompting for Codex

Use this skill when `duet:codex-worker` hands a task to Codex. Model names from before the GPT-6 family are retired for ChatGPT sign-in, so never pass them.

Last checked against OpenAI documentation: 2026-11-12. Model names and effort levels change; if Codex rejects a model or effort, drop the flag and let Codex use its own default.

## The prompt contract

Write an assignment, not a script. GPT-6 models work best when the prompt fixes the outcome and the finish line and leaves the route to the model. Every delegated prompt carries four parts, as plain labelled sections:

- **Goal** — the change or answer wanted, in one or two sentences, and why it matters.
- **Context** — the files, directories, errors, logs, commands or docs that matter. Name paths; do not paste whole files Codex can read itself.
- **Constraints** — scope limits, conventions, things that must not change, safety rules.
- **Done when** — checks that can be observed: a test passes, a command prints X, a bug no longer reproduces, a report contains named sections.

Then add only what the task needs:

- **Autonomy line** (almost always, because a delegated run has nobody to answer questions): tell Codex to infer intent, make reasonable low-risk assumptions, keep going to completion, and list its assumptions in the final report. Tell it to stop only before destructive or irreversible actions.
- **Verification scope**: name the checks to run. GPT-6 models tend to over-test, so say when testing is unnecessary (small, reversible edits) and that checks are rerun only after new changes or failures.
- **Output shape**: the default output is long and heavily formatted. Ask for the main point first, short paragraphs, lists only for parallel items, no closing recap, and the exact sections you need back.
- **Grounding** (review, diagnosis, research): separate observed facts from inferences; mark hypotheses as such.
- **Delegation** (only with `ultra` effort or multi-agent work): say which parts may run as parallel subagents and how results are merged.

## Rules

- One task per run. Split unrelated asks into separate runs.
- Keep the prompt free of contradictions. GPT-6 models follow long instructions closely and are sensitive to everything in context, including `AGENTS.md` and skills; conflicting guidance makes them pause early.
- Keep absolute wording (`must`, `never`) for real invariants. Explain the reason for a constraint when it is not obvious.
- Durable repository rules belong in `AGENTS.md`, not in every prompt. If the repository has no `AGENTS.md`, put the few rules that matter into Constraints.
- Do not ask for running commentary, upfront plans or status preambles in a delegated run. Ask for one final report.
- Fix the prompt before raising reasoning effort. A missing "Done when" costs more than a lower effort level.
- For follow-ups use `task --resume-last` and send only the delta, not the whole prompt again.
- Structure with plain labels or a few XML tags; either works. Do not wrap every sentence in a tag.

## Model and effort

Leave `--model` and `--effort` unset unless the user chose them; Codex then uses the user's configured defaults. When the user asks which to use, see [references/model-and-effort.md](references/model-and-effort.md).

## References

- Templates for common tasks: [references/prompt-recipes.md](references/prompt-recipes.md)
- Model lineup, effort levels, retired models: [references/model-and-effort.md](references/model-and-effort.md)
- Failure modes carried over from older prompts: [references/antipatterns.md](references/antipatterns.md)

## Assembly checklist

1. Goal, Context, Constraints, Done when are all present and concrete.
2. The autonomy line is there, with the stop condition for irreversible actions.
3. Verification names specific commands or says none are needed.
4. The output shape lists the sections expected back.
5. Nothing contradicts `AGENTS.md` or another line of the prompt.
6. Anything Codex can discover by reading the repository has been removed.
