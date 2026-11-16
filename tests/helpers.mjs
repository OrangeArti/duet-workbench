// Modified from openai/codex-plugin-cc@db52e28 (Apache-2.0) by Duet Workbench; see NOTICE.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Tests run inside Claude Code sessions too; drop the host plugin env so state stays in temp dirs.
for (const key of Object.keys(process.env)) {
  if (key === "CLAUDE_PLUGIN_DATA" || key.startsWith("CODEX_COMPANION_") || key.startsWith("DUET_")) delete process.env[key];
}
process.env.DUET_STATE_ROOT = path.join(os.tmpdir(), "duet-workbench");

// Brokers are detached and outlive the test; stop the ones serving this file's temp dirs
// (basename: a write run's broker serves a worktree under state/<basename>-<hash>/).
// shortcut: pkill is POSIX only, on Windows the brokers still leak; use taskkill if tests run there.
const tempDirs = [];
process.on("exit", () => {
  for (const dir of tempDirs) spawnSync("pkill", ["-f", `app-server-broker.mjs serve .*${path.basename(dir)}`]);
});

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
