# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's private report: the repository's **Security** tab, then **Report a vulnerability**. Say what you did, what happened and what you expected. You will get an answer as soon as the maintainer can look at it.

## What Duet Workbench guarantees

- The project mirror only copies restrictions from Claude to Codex. It never writes `danger-full-access`, never turns the sandbox off, never bypasses Codex's hook trust, and never edits a project's `.claude/` directory or `CLAUDE.md`.
- Everything it writes into a project is recorded in a ledger; `/duet:remove` restores the project exactly.
- It never reads or prints credentials (`~/.codex/auth.json`, `.env*`, keys, tokens). Sign-in is checked through the Codex app server. A review (`/duet:review`) does not copy untracked files named like credentials (`.env*`, `*.pem`, `*.key`, `id_rsa`, `auth.json`, …) or symlinks that point outside the repository into Codex's prompt.
- Task text is passed to Codex on stdin or by file, never inside a shell string. Codex output is treated as data and is never executed.

## What it does not guarantee

- Rules that match a command prefix see only the shell line Codex runs. The hard boundary is the filesystem denies and the network being off; see `docs/sync-mapping.md`.
- The sandbox is Codex's own. Duet Workbench configures it and does not replace it.
