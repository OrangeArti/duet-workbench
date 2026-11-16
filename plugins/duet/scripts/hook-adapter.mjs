#!/usr/bin/env node
// duet-workbench hook adapter. Codex runs this as a PreToolUse hook; it applies the project's
// Claude-side guards to Codex tool calls. Exit 2 with a reason on stderr blocks the call.
//
// This file is copied into a project as .duet-workbench/hook-adapter.mjs, so it must stay
// self-contained (Node standard library only). Everything project-specific is in guard.json.
// It fails closed: an unattended run must not continue without its guard.
//
// Limits: command rules match the start of each part of a shell line (split on && || ; | &),
// like Claude Code's own prefix rules. A command hidden inside a script or `sh -c "…"` string
// is not seen here; filesystem denies in the permission profile are the hard boundary.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE_TOOLS = ["Write", "Edit", "MultiEdit"];

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

export function commandParts(command) {
  return [command, ...command.split(/&&|\|\||[;|&\n]/)]
    .map((part) => part.trim().replace(/^[({]\s*/, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""))
    .filter(Boolean);
}

export function ruleMatches(pattern, part) {
  if (pattern === "*") {
    return true;
  }
  const base = pattern.endsWith(":*") ? pattern.slice(0, -2) : pattern;
  if (!base.includes("*")) {
    return part === base || part.startsWith(`${base} `);
  }
  const source = base.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${source}$`, "s").test(part);
}

export function parsePatch(patch, cwd) {
  const files = [];
  let current = null;
  for (const line of String(patch).split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (header) {
      current = { file_path: path.resolve(cwd, header[2].trim()), lines: [] };
      files.push(current);
    } else if (move && current) {
      files.push({ file_path: path.resolve(cwd, move[1].trim()), lines: current.lines });
    } else if (current && line.startsWith("+")) {
      current.lines.push(line.slice(1));
    }
  }
  return files.map((file) => ({ file_path: file.file_path, content: file.lines.join("\n") }));
}

function matcherAllows(matcher, tool) {
  if (!matcher || matcher === "*") {
    return true;
  }
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

function toolInput(tool, file) {
  if (tool === "Write") {
    return { file_path: file.file_path, content: file.content };
  }
  if (tool === "Edit") {
    return { file_path: file.file_path, old_string: "", new_string: file.content };
  }
  return { file_path: file.file_path, edits: [{ old_string: "", new_string: file.content }] };
}

// In a worktree run (duet-workbench F9) Codex runs this copy from the main checkout, but the call's
// paths are in the worktree. The guards see the same paths inside this project, so they decide
// exactly as they would here. Returns a mapper, or null when cwd is not a worktree of this repo.
function worktreeMapper(cwd) {
  const real = cwd && fs.existsSync(cwd) ? fs.realpathSync(cwd) : null;
  if (!real || real === ROOT || real.startsWith(`${ROOT}${path.sep}`)) {
    return null;
  }
  const git = (dir, args) => spawnSync("git", ["-C", dir, "rev-parse", ...args], { encoding: "utf8" });
  const theirs = git(cwd, ["--show-toplevel", "--git-common-dir"]);
  const ours = git(ROOT, ["--git-common-dir"]);
  if (theirs.status !== 0 || ours.status !== 0) {
    return null;
  }
  const [top, common] = theirs.stdout.trim().split("\n");
  if (fs.realpathSync(path.resolve(cwd, common)) !== fs.realpathSync(path.resolve(ROOT, ours.stdout.trim()))) {
    return null;
  }
  // Codex may spell the worktree path without resolving symlinks (/var vs /private/var on macOS).
  const suffix = path.relative(top, real);
  const prefixes = [top, suffix ? cwd.slice(0, cwd.length - suffix.length - 1) : cwd];
  return (file) => {
    const prefix = prefixes.find((item) => file === item || file.startsWith(`${item}${path.sep}`));
    return prefix ? path.join(ROOT, path.relative(prefix, file)) : file;
  };
}

function runHook(hook, input, toolName, toolInputValue, toProject = (file) => file) {
  const event = {
    session_id: input.session_id ?? null,
    transcript_path: input.transcript_path ?? null,
    cwd: toProject(input.cwd ?? ROOT),
    hook_event_name: "PreToolUse",
    permission_mode: input.permission_mode ?? "default",
    tool_name: toolName,
    tool_input: toolInputValue
  };
  // The command comes from the project's own .claude/settings.json and is run the way Claude Code runs it.
  const result = spawnSync(hook.command, {
    shell: true,
    cwd: ROOT,
    input: JSON.stringify(event),
    encoding: "utf8",
    timeout: (hook.timeout ?? 60) * 1000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT }
  });
  if (result.error) {
    block(`Blocked: the project's guard hook could not run (${result.error.message}). Report this instead of retrying.`);
  }
  if (result.status === 2) {
    block(result.stderr.trim() || "Blocked by the project's guard hook.");
  }
  if (result.status !== 0) {
    block(`Blocked: the project's guard hook failed (exit ${result.status}). ${result.stderr.trim()} Report this instead of retrying.`);
  }
  let output = null;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    return;
  }
  const decision = output?.hookSpecificOutput?.permissionDecision;
  if (decision === "deny" || decision === "ask") {
    // Nobody can answer "ask" in a delegated run, so it is a denial.
    block(output.hookSpecificOutput.permissionDecisionReason || "Blocked by the project's guard hook: this action needs a human. Report that it is needed.");
  }
  if (output?.decision === "block" || output?.continue === false) {
    block(output.reason || output.stopReason || "Blocked by the project's guard hook.");
  }
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const guard = JSON.parse(fs.readFileSync(path.join(ROOT, ".duet-workbench", "guard.json"), "utf8"));
  const raw = input.tool_input?.command ?? "";
  const command = Array.isArray(raw) ? raw.join(" ") : String(raw);
  const toProject = worktreeMapper(input.cwd) ?? ((file) => file);

  if (input.tool_name === "Bash") {
    for (const part of commandParts(command)) {
      const hit = (guard.deny ?? []).find((rule) => ruleMatches(rule.pattern, part));
      if (hit) {
        block(`Blocked by this project's rules (${hit.rule}): this command needs a human. Do not look for another way to run it; report that it is needed.`);
      }
    }
    for (const hook of guard.hooks ?? []) {
      if (matcherAllows(hook.matcher, "Bash")) {
        runHook(hook, input, "Bash", { command }, toProject);
      }
    }
    return;
  }

  if (input.tool_name === "apply_patch") {
    const fileHooks = (guard.hooks ?? [])
      .map((hook) => ({ hook, tool: FILE_TOOLS.find((tool) => matcherAllows(hook.matcher, tool)) }))
      .filter((item) => item.tool);
    if (fileHooks.length === 0) {
      return;
    }
    const files = parsePatch(command, input.cwd ?? ROOT);
    if (files.length === 0) {
      block("Blocked: duet-workbench could not read the files in this patch, so the project's guard cannot check it. Report this instead of retrying.");
    }
    for (const { hook, tool } of fileHooks) {
      for (const file of files) {
        runHook(hook, input, tool, toolInput(tool, { ...file, file_path: toProject(file.file_path) }), toProject);
      }
    }
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    block(`Blocked: the duet-workbench guard could not start (${error.message}). Report this instead of retrying.`);
  }
}
