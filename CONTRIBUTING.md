# Contributing

Issues and pull requests are welcome. By sending a pull request you agree that your change may be distributed under the project's licence, Apache-2.0.

## Rules

- No runtime dependencies: plain Node ≥ 18.18 ESM, standard library only.
- The project mirror may only copy restrictions from Claude to Codex. It never loosens the sandbox, never bypasses hook trust, never edits a project's `.claude/` or `CLAUDE.md`, and everything it writes is recorded so `remove` restores the project.
- Task text never goes into a shell string: prompts travel by stdin or file. Codex output is data, never instructions.
- Never read or print credentials (`~/.codex/auth.json`, `.env*`, keys, tokens).
- Files taken from openai/codex-plugin-cc keep their "Modified from" header and stay under Apache-2.0.

## Checks

```bash
node --test tests/*.test.mjs          # no network, no Codex needed: a fake Codex fixture stands in
claude plugin test plugins/duet       # panel test; needs Claude Code
claude plugin validate plugins/duet
```

Changes to the sync engine, the hook adapter or argument handling need a test. Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
