---
description: Check Codex prerequisites, drift and which of this project's rules Codex enforces (read-only)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
<!-- duet-workbench command (not derived from upstream). -->

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" doctor`

Present the report as is, in its three groups (Prerequisites, Drift, Coverage). Do not run any fix yourself; each `FIX` line already names the step. If there is drift, mention `/duet:sync`.
