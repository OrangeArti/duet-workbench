---
description: Remove Duet Workbench from this project and restore the files it changed
allowed-tools: Bash(node:*), AskUserQuestion
---
<!-- duet-workbench command (not derived from upstream). -->

1. Preview:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" remove --dry-run
```

2. Present the list and use `AskUserQuestion` once: `Remove (Recommended)` / `Cancel`.
3. On `Remove`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" remove` and present the output as is. Files the plugin created are deleted; in files that were already there, only the parts the plugin added are removed.
