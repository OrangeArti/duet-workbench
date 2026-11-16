---
description: Transfer the current Claude Code session into a resumable Codex thread
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
<!-- Modified from openai/codex-plugin-cc@db52e28 (Apache-2.0) by Duet Workbench; see NOTICE. -->

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command.
