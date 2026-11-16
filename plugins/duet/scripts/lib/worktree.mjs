// F9: write runs happen in their own git worktree on branch duet/<job-id>, so two runs (or a run and
// Claude) never edit the same files on disk. The result is applied to the main checkout on request.
// V9 (docs/research.md): Codex trusts a worktree through the main repository and reads hooks from the
// main checkout, but reads .codex/config.toml from the worktree, so the mirror is copied in.
import fs from "node:fs";
import path from "node:path";

import { checkoutConfigToml, isInitialised, mirrorPaths } from "../sync/engine.mjs";
import { runCommand, runCommandChecked } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

const git = (cwd, args) => runCommand("git", args, { cwd, shell: false });
const gitOut = (cwd, args) => runCommandChecked("git", args, { cwd, shell: false }).stdout.trim();
const lines = (text) => text.split("\n").filter(Boolean);
// The branch commit is temporary (apply squashes it into the working tree), so a fixed identity is fine.
const IDENTITY = ["-c", "user.name=duet-workbench", "-c", "user.email=duet-workbench@localhost", "-c", "commit.gpgsign=false"];

export function canUseWorktree(root) {
  return git(root, ["rev-parse", "--verify", "-q", "HEAD"]).status === 0;
}

export function createJobWorktree(root, jobId) {
  const dir = path.join(resolveStateDir(root), "worktrees", jobId);
  const branch = `duet/${jobId}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  gitOut(root, ["worktree", "add", "-q", "-b", branch, dir, "HEAD"]);
  // The plugin's mirror plus any Codex config or instructions git would not put in the worktree
  // (untracked, ignored or edited), so Codex runs there under the same rules as here.
  const local = lines(gitOut(root, ["ls-files", "--others", "--modified", "--", ".codex", ":(glob)**/AGENTS.md", ":(glob)**/AGENTS.override.md"]));
  const mirror = [...new Set([...mirrorPaths(root), ...local])];
  for (const rel of mirror) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.cpSync(path.join(root, rel), path.join(dir, rel), { recursive: true });
  }
  if (isInitialised(root)) {
    const toml = path.join(dir, ".codex", "config.toml");
    fs.writeFileSync(toml, checkoutConfigToml(root, fs.readFileSync(toml, "utf8")));
  }
  return { path: dir, branch, base: gitOut(root, ["rev-parse", "HEAD"]), mirror, state: "pending", files: [] };
}

// Uncommitted work in the main checkout that a worktree run will not see (mirror files aside).
export function uncommittedFiles(root) {
  const mirror = mirrorPaths(root);
  return lines(gitOut(root, ["status", "--porcelain"]))
    .map((line) => line.slice(3))
    .filter((file) => !mirror.some((rel) => file === rel || file.startsWith(`${rel}/`)));
}

// Commit what the run changed (never the copied mirror) and report the files changed since the base.
export function finishJobWorktree(worktree, title) {
  // Stage all, then unstage the mirror: naming a gitignored mirror file in `git add`, even as an
  // exclude, makes git refuse the whole command.
  gitOut(worktree.path, ["add", "-A", "--", "."]);
  if (worktree.mirror.length) {
    gitOut(worktree.path, ["reset", "-q", "--", ...worktree.mirror]);
  }
  if (lines(gitOut(worktree.path, ["diff", "--cached", "--name-only"])).length) {
    gitOut(worktree.path, [...IDENTITY, "commit", "-q", "--no-verify", "-m", `duet-workbench: ${title}`]);
  }
  const files = lines(gitOut(worktree.path, ["diff", "--name-only", `${worktree.base}..HEAD`]));
  return { ...worktree, files, state: files.length ? "pending" : "empty" };
}

export function removeJobWorktree(root, worktree) {
  if (fs.existsSync(worktree.path)) {
    git(root, ["worktree", "remove", "--force", worktree.path]);
  }
  git(root, ["worktree", "prune"]);
  git(root, ["branch", "-D", worktree.branch]);
}

// Apply = the run's changes land in the main checkout's working tree (staged, not committed),
// so they are reviewed and committed like any other edit.
export function applyJobWorktree(root, worktree) {
  const check = git(root, ["merge-tree", "--write-tree", "--name-only", "HEAD", worktree.branch]);
  if (check.status === 1) {
    const conflicts = lines(check.stdout).slice(1).filter((line) => !line.startsWith("Auto-merging") && !line.startsWith("CONFLICT"));
    throw new Error(`The changes on ${worktree.branch} conflict with your branch in: ${conflicts.join(", ") || "some files"}. Nothing was changed. Merge the branch yourself (git merge ${worktree.branch}) or discard it.`);
  }
  // shortcut: git older than 2.38 has no merge-tree --write-tree (status 129), so a conflict is only
  // found by the merge itself and leaves markers; upgrade if older git must be supported.
  const merged = git(root, ["merge", "--squash", "--no-commit", worktree.branch]);
  if (merged.status !== 0) {
    throw new Error(`Could not apply ${worktree.branch}: ${(merged.stderr || merged.stdout).trim()} Commit or stash your own edits to those files, then apply again.`);
  }
  removeJobWorktree(root, worktree);
  return worktree.files;
}
