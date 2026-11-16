# Models and reasoning effort in Codex

Checked 2026-11-12 against the Codex Models page, the Codex configuration reference and OpenAI's "Using GPT-6" guide. Availability depends on plan, client, workspace settings and rollout, so treat this as a starting point and trust what `codex` itself reports (`/model` in the CLI).

## Models

| Alias | Model id | Use it for | Suggested starting effort |
|---|---|---|---|
| `sol` | `gpt-6.1-sol` | Default for coding, research and long-running agent work. Near-Astra quality at lower cost. | the client default |
| `astra` | `gpt-6-astra` | The hardest reasoning and end-to-end work, when Sol's answer misses connections. Uses the most allowance. | `low` |
| `terra` | `gpt-6.1-terra` | Clear writing, visual understanding, computer use. Needs Codex CLI 0.159.0 or later. | no official suggestion; start at the client default |
| `luna` | `gpt-6-luna` | Focused, repeatable, high-volume work: extraction, summaries, small scoped edits. The only choice on Free and Go plans. | `high` |

## Effort levels

| Value | App label | Meaning |
|---|---|---|
| `low` | Light | Quick, well-scoped tasks |
| `medium` | Medium | Balance of speed and depth; work needing some judgment |
| `high` | High | Difficult multi-step work |
| `xhigh` | Extra High | The hardest multi-step work with many sources or trade-offs |
| `max` | Max | More reasoning time for one model on one task whose parts depend on each other |
| `ultra` | Ultra | Splits the task across parallel subagents; only worth it when the work divides into independent parts, and it needs a merge step |

Notes:

- `none` exists only on some models (GPT-6.1 Terra, GPT-6 Luna, GPT-6 Sol). GPT-6.1 Sol and GPT-6 Astra do not accept `none` or `minimal`; use `low`.
- GPT-6 Luna supports up to `max`, not `ultra`.
- Effort levels do not map one-to-one across model generations. Do not carry a setting from an older model over blindly; start from the suggestion above and adjust on a task you understand.
- Speed tiers (Fast, Ultrafast) are separate from effort and consume allowance at a higher rate.

## Retired for ChatGPT sign-in

Every model name from before the GPT-6 family is retired; replace it with `gpt-6.1-sol`, or `gpt-6-luna` for speed and volume.
Check `~/.codex/config.toml`, project `.codex/config.toml`, custom agents and scripts for these names.

## Picking for a delegated task

- Routine fix, small feature, test writing: Sol at the default effort.
- Bulk mechanical edits, extraction, summarising logs: Luna at `high`.
- Root cause that survived one attempt, architecture trade-off, security review: Sol at `high` or `xhigh`; move to Astra at `low` if Sol's result is shallow.
- Prose, docs, screenshots, UI checks: Terra.
- Independent audits of several areas at once: Sol at `ultra`, with the split described in the prompt.

## Sources

- https://learn.chatgpt.com/docs/models
- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.1-sol
- https://openai.com/index/practical-guide-building-gpt-6/
