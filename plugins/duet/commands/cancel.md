---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
<!-- Modified from openai/codex-plugin-cc@db52e28 (Apache-2.0) by Duet Workbench; see NOTICE. -->

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" cancel "$ARGUMENTS"`
