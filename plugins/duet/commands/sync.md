---
description: Bring Codex's copy of this project's rules up to date with the Claude-side rules
argument-hint: '[--overwrite-edited]'
allowed-tools: Bash(node:*), AskUserQuestion
---
<!-- duet-workbench command (not derived from upstream). -->

1. Check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" sync-check
```

2. If it says "In sync", present that line and stop. If it says "Not set up", offer `/duet:init` and stop.
3. Otherwise apply:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" sync-apply $ARGUMENTS
```

4. Present the output as is. If it reports a file that was edited by hand and skipped, use `AskUserQuestion` once: `Keep my edit (Recommended)` / `Replace with the generated version`. On replace, run `sync-apply --overwrite-edited` and present its output.
