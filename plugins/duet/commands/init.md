---
description: Set up this project for Codex — mirror its Claude rules and security settings (one step, reversible with /duet:remove)
allowed-tools: Bash(node:*), AskUserQuestion
---
<!-- duet-workbench command (not derived from upstream). -->

1. Preview, without writing anything:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" sync-apply --init --dry-run
```

2. If the preview says "Nothing was written" (a conflict), present it as is and stop. If it says nothing would change, say the project is already set up and stop.
3. Otherwise present the preview list and use `AskUserQuestion` once: `Set up (Recommended)` / `Cancel`.
4. On `Set up`, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/duet-runtime.mjs" sync-apply --init
```

5. Present the output as is. Its last lines are the steps only the user can do in Codex (trust the folder, and the hook when there is one); keep them exact and say they are needed once.
6. Add one line: the created files hold no personal data and can be committed, so teammates get the same restrictions; `/duet:remove` restores the project exactly.

Never edit `.claude/` or `CLAUDE.md`, and never run anything else.
