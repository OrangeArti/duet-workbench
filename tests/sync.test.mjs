import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import { applySync, buildPlan, checkSync, removeMirror, trustProblems } from "../plugins/duet/scripts/sync/engine.mjs";

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function snapshot(root, dir = "", out = {}) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out[`${rel}/`] = "dir";
      snapshot(root, rel, out);
    } else {
      out[rel] = fs.readFileSync(path.join(root, rel), "utf8");
    }
  }
  return out;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

const GUARD_SCRIPT = `import fs from "node:fs";
const event = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(process.env.CLAUDE_PROJECT_DIR + "/guard-log.jsonl", JSON.stringify(event) + "\\n");
const text = JSON.stringify(event.tool_input);
if (text.includes("ASKME")) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "needs approval" } }));
} else if (text.includes("TOPSECRET")) {
  console.error("guard-secrets: refusing to touch a secret");
  process.exit(2);
}
`;

function richProject() {
  const root = makeTempDir();
  write(root, "CLAUDE.md", "# Project\n\nAlways run the tests.\n\n## Claude only\n\nUse the Task tool.\n\n## Style\n\nTabs.\n");
  write(root, ".claude/hooks/guard-secrets.mjs", GUARD_SCRIPT);
  write(
    root,
    ".claude/settings.json",
    JSON.stringify({
      permissions: {
        deny: ["Read(./.env)", "Read(.env.*)", "Read(~/.ssh/**)", "Read(//etc/secret.conf)", "Edit(/infra/prod.tf)", "Bash(rm -rf:*)", "WebFetch(domain:evil.example)"],
        ask: ["Bash(git push:*)", "Bash(npm publish *)", "mcp__github__create_issue"]
      },
      sandbox: { enabled: true, network: { allowedDomains: ["api.github.com", "*.npmjs.org"], allowLocalBinding: false }, excludedCommands: ["docker"] },
      hooks: {
        PreToolUse: [
          { matcher: "Bash|Edit|Write", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-secrets.mjs"' }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/company-guard" }] },
          { matcher: "Read|Grep", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-secrets.mjs"' }] }
        ],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo done" }] }]
      }
    })
  );
  write(root, ".claude/settings.local.json", "{}");
  return root;
}

test("init then remove on a clean project leaves the tree byte-identical", () => {
  const root = makeTempDir();
  write(root, "CLAUDE.md", "# Rules\n\nBe careful.\n");
  write(root, "src/a.js", "x\n");
  const before = snapshot(root);

  const result = applySync(root, { init: true });
  assert.equal(result.applied, true);
  assert.match(read(root, "AGENTS.md"), /Be careful\./);
  assert.match(read(root, ".codex/config.toml"), /default_permissions = "duet-read"/);
  assert.ok(fs.existsSync(path.join(root, ".duet-workbench/state.json")));
  assert.equal(fs.existsSync(path.join(root, ".codex/hooks.json")), false, "no hook is registered when there is nothing to guard");
  assert.equal(checkSync(root).state, "in-sync");

  const preview = removeMirror(root, { dryRun: true });
  assert.deepEqual(snapshot(root)["AGENTS.md"], read(root, "AGENTS.md"));
  assert.ok(preview.actions.some((action) => action.target === "AGENTS.md" && action.action === "delete"));
  removeMirror(root);
  assert.deepEqual(snapshot(root), before);
});

test("init preserves a user's AGENTS.md, config.toml and hooks.json; remove restores them exactly", () => {
  const root = richProject();
  const userAgents = "# My Codex notes\n\nPrefer small diffs.";
  const userToml = '# my settings\nmodel = "gpt-6-luna"\ndefault_permissions = ":workspace"\n\n[features]\nfoo = true\n';
  const userHooks = '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}]}}';
  write(root, "AGENTS.md", userAgents);
  write(root, ".codex/config.toml", userToml);
  write(root, ".codex/hooks.json", userHooks);
  const before = snapshot(root);

  const result = applySync(root, { init: true });
  assert.equal(result.applied, true);
  assert.ok(result.notes.some((note) => /sets default_permissions/.test(note)));
  assert.ok(read(root, "AGENTS.md").startsWith(`${userAgents}\n<!-- duet-workbench:begin -->`));
  const tomlNow = read(root, ".codex/config.toml");
  for (const line of userToml.split("\n")) {
    assert.ok(tomlNow.includes(line), line);
  }
  assert.equal((tomlNow.match(/^default_permissions/gm) ?? []).length, 1, "the user's key is not duplicated");
  assert.match(tomlNow, /\[permissions\.duet-read\]/);
  const hooks = JSON.parse(read(root, ".codex/hooks.json")).hooks.PreToolUse;
  assert.equal(hooks[0].hooks[0].command, "echo mine");
  assert.match(hooks[1].hooks[0].command, /\.duet-workbench\/hook-adapter\.mjs/);

  removeMirror(root);
  assert.deepEqual(snapshot(root), before);
});

test("remove keeps a user's later edits to hooks.json and drops only the adapter entry", () => {
  const root = richProject();
  applySync(root, { init: true });
  const data = JSON.parse(read(root, ".codex/hooks.json"));
  data.hooks.PreToolUse.unshift({ matcher: "Bash", hooks: [{ type: "command", command: "echo later" }] });
  write(root, ".codex/hooks.json", JSON.stringify(data));
  removeMirror(root);
  assert.deepEqual(JSON.parse(read(root, ".codex/hooks.json")), { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo later" }] }] } });
  assert.equal(fs.existsSync(path.join(root, ".duet-workbench")), false);
});

test("sync is idempotent", () => {
  const root = richProject();
  applySync(root, { init: true });
  const first = snapshot(root);
  const second = applySync(root);
  assert.deepEqual(second.changes, []);
  assert.deepEqual(snapshot(root), first);
});

test("editing CLAUDE.md or settings shows as drift and sync clears it", () => {
  const root = richProject();
  applySync(root, { init: true });
  fs.appendFileSync(path.join(root, "CLAUDE.md"), "\nNever force-push.\n");
  const drift = checkSync(root);
  assert.equal(drift.state, "differences");
  assert.deepEqual(drift.changedSources, ["CLAUDE.md"]);
  assert.deepEqual(drift.differences.map((item) => [item.target, item.kind]), [["AGENTS.md", "stale"]]);

  const result = applySync(root);
  assert.deepEqual(result.changes, [{ target: "AGENTS.md", action: "update" }]);
  assert.match(read(root, "AGENTS.md"), /Never force-push\./);
  assert.equal(checkSync(root).state, "in-sync");

  fs.rmSync(path.join(root, ".duet-workbench/guard.json"));
  assert.deepEqual(checkSync(root).differences.map((item) => item.kind), ["missing"]);
  applySync(root);
  assert.equal(checkSync(root).state, "in-sync");
});

test("a project that was never initialised is left untouched", () => {
  const root = richProject();
  const before = snapshot(root);
  assert.equal(checkSync(root).state, "not-initialised");
  assert.throws(() => applySync(root), /not set up/);
  assert.throws(() => removeMirror(root), /not set up/);
  const preview = applySync(root, { init: true, dryRun: true });
  assert.equal(preview.applied, false);
  assert.ok(preview.changes.some((change) => change.target === "AGENTS.md" && change.action === "create"));
  assert.deepEqual(snapshot(root), before);
});

test("restrictions are mirrored and every rule is enforced or explained", () => {
  const root = richProject();
  applySync(root, { init: true });
  const toml = read(root, ".codex/config.toml");
  const [readProfile, writeProfile] = toml.split("[permissions.duet]\n");

  for (const profile of [readProfile, writeProfile]) {
    assert.match(profile, /"\*\*\/\.env" = "deny"/);
    assert.match(profile, /"\*\*\/\.env\.\*" = "deny"/);
    assert.match(profile, /"~\/\.ssh\/\*\*" = "deny"/);
    assert.match(profile, /"\/etc\/secret\.conf" = "deny"/);
    assert.doesNotMatch(profile, /network/);
  }
  assert.match(readProfile, /extends = ":read-only"/);
  assert.doesNotMatch(readProfile, /"write"/);
  assert.match(writeProfile, /extends = ":workspace"/);
  assert.match(writeProfile, /"\." = "write"/);
  for (const key of ["infra/prod.tf", ".codex", ".duet-workbench", ".claude", "AGENTS.md"]) {
    assert.ok(writeProfile.includes(`${JSON.stringify(key)} = "read"`), key);
  }
  assert.doesNotMatch(toml, /danger-full-access/);

  const guard = JSON.parse(read(root, ".duet-workbench/guard.json"));
  assert.deepEqual(guard.deny.map((rule) => [rule.pattern, rule.kind]), [["rm -rf:*", "deny"], ["git push:*", "ask"], ["npm publish *", "ask"]]);
  assert.deepEqual(guard.hooks.map((hook) => hook.matcher), ["Bash|Edit|Write"]);

  const agents = read(root, "AGENTS.md");
  assert.match(agents, /### Needs a human\n\n- `WebFetch\(domain:evil\.example\)` — forbidden/);
  assert.match(agents, /`Bash\(git push:\*\)` — Claude Code asks a human/);
  assert.match(agents, /Always run the tests\./);

  const outcome = Object.fromEntries(checkSync(root).rules.map((rule) => [rule.rule, rule.outcome]));
  assert.equal(outcome["permissions.deny: Read(./.env)"], "enforced");
  assert.equal(outcome["permissions.deny: Edit(/infra/prod.tf)"], "enforced");
  assert.equal(outcome["permissions.ask: Bash(git push:*)"], "enforced");
  assert.equal(outcome["permissions.deny: WebFetch(domain:evil.example)"], "instruction-only");
  assert.equal(outcome["permissions.ask: mcp__github__create_issue"], "instruction-only");
  assert.equal(outcome["sandbox.enabled"], "enforced");
  assert.equal(outcome["sandbox.network.allowedDomains"], "not mirrored");
  assert.equal(outcome["sandbox.excludedCommands"], "not mirrored");
  assert.equal(outcome['hooks.PreToolUse[Bash|Edit|Write]: node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-secrets.mjs"'], "enforced");
  assert.equal(outcome["hooks.PreToolUse[Bash]: /usr/local/bin/company-guard"], "not mirrored");
  assert.equal(outcome['hooks.PreToolUse[Read|Grep]: node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-secrets.mjs"'], "not mirrored");
  assert.equal(outcome["hooks.PostToolUse"], "not mirrored");
  assert.equal(outcome[".claude/settings.local.json"], "not mirrored");
  assert.equal(outcome["CLAUDE.md"], "enforced");
  for (const rule of checkSync(root).rules) {
    assert.ok(rule.how, rule.rule);
  }

  // The guard script is a source: changing it is drift.
  fs.appendFileSync(path.join(root, ".claude/hooks/guard-secrets.mjs"), "// change\n");
  assert.deepEqual(checkSync(root).changedSources, [".claude/hooks/guard-secrets.mjs"]);
});

test("project options: network opt-in, external hook opt-in, excluded headings", () => {
  const root = richProject();
  applySync(root, { init: true });
  write(root, ".duet-workbench/config.json", JSON.stringify({ mirrorNetwork: true, mirrorExternalHooks: ["/usr/local/bin/company-guard"], excludeHeadings: ["Claude only"] }));
  applySync(root);
  const toml = read(root, ".codex/config.toml");
  assert.match(toml, /\[permissions\.duet\.network\]\nenabled = true\nallow_local_binding = false\n\n\[permissions\.duet\.network\.domains\]\n"api\.github\.com" = "allow"\n"\*\.npmjs\.org" = "allow"/);
  assert.equal(JSON.parse(read(root, ".duet-workbench/guard.json")).hooks.length, 2);
  const agents = read(root, "AGENTS.md");
  assert.doesNotMatch(agents, /Use the Task tool/);
  assert.match(agents, /## Style\n\nTabs\./);
});

test("large instructions raise the byte budget, then switch to pointer mode", () => {
  const root = makeTempDir();
  write(root, "CLAUDE.md", `# Big\n\n${"rule line\n".repeat(4000)}`);
  applySync(root, { init: true });
  assert.match(read(root, ".codex/config.toml"), /^project_doc_max_bytes = (\d+)$/m);
  const budget = Number(/project_doc_max_bytes = (\d+)/.exec(read(root, ".codex/config.toml"))[1]);
  assert.ok(budget >= fs.statSync(path.join(root, "AGENTS.md")).size && budget <= 65536);

  write(root, "CLAUDE.md", `# Huge\n\n${"rule line\n".repeat(8000)}`);
  applySync(root);
  const agents = read(root, "AGENTS.md");
  assert.match(agents, /read `CLAUDE\.md` in this directory in full/);
  assert.ok(agents.length < 4000);
  assert.doesNotMatch(read(root, ".codex/config.toml"), /project_doc_max_bytes/);
  assert.equal(checkSync(root).rules.find((rule) => rule.rule === "CLAUDE.md").outcome, "instruction-only");
});

test("denying a directory's contents also denies listing the directory", () => {
  const root = makeTempDir();
  write(root, "CLAUDE.md", "# Rules\n");
  write(root, ".claude/settings.json", JSON.stringify({ permissions: { deny: ["Read(~/.ssh/**)", "Read(./secrets/**)", "Read(**)"] } }));
  applySync(root, { init: true });
  const toml = read(root, ".codex/config.toml");
  assert.match(toml, /^"~\/\.ssh\/\*\*" = "deny"$/m);
  assert.match(toml, /^"~\/\.ssh" = "deny"$/m);
  assert.match(toml, /^"secrets" = "deny"$/m);
  // A bare ** has no directory of its own to add.
  assert.doesNotMatch(toml, /^"" = /m);
});

test("a project's own smaller project_doc_max_bytes is kept and forces pointer mode", () => {
  const root = makeTempDir();
  write(root, ".codex/config.toml", "project_doc_max_bytes = 8192\n");
  write(root, "CLAUDE.md", `# Big\n\n${"rule line\n".repeat(4000)}`);
  applySync(root, { init: true });

  assert.match(read(root, "AGENTS.md"), /read `CLAUDE\.md` in this directory in full/);
  assert.ok(fs.statSync(path.join(root, "AGENTS.md")).size <= 8192);
  assert.equal(read(root, ".codex/config.toml").match(/project_doc_max_bytes/g).length, 1);
  const check = checkSync(root);
  assert.equal(check.state, "in-sync");
  assert.equal(check.rules.find((rule) => rule.rule === "CLAUDE.md").outcome, "instruction-only");
  assert.doesNotMatch(check.notes.join("\n"), /cut the rules short/);
});

test("nested CLAUDE.md files get their own AGENTS.md, which goes away with its source", () => {
  const root = makeTempDir();
  write(root, "CLAUDE.md", "# Root\n");
  write(root, "packages/api/CLAUDE.md", "# API\n\nNo raw SQL.\n");
  write(root, "node_modules/x/CLAUDE.md", "ignored\n");
  const before = snapshot(root);
  applySync(root, { init: true });
  assert.match(read(root, "packages/api/AGENTS.md"), /No raw SQL\./);
  assert.equal(fs.existsSync(path.join(root, "node_modules/x/AGENTS.md")), false);
  assert.match(read(root, ".codex/config.toml"), /"packages\/api\/AGENTS\.md" = "read"/);

  fs.rmSync(path.join(root, "packages/api/CLAUDE.md"));
  assert.deepEqual(checkSync(root).differences.map((item) => [item.target, item.kind]).filter(([, kind]) => kind === "orphan"), [["packages/api/AGENTS.md", "orphan"]]);
  applySync(root);
  assert.equal(fs.existsSync(path.join(root, "packages/api/AGENTS.md")), false);
  assert.equal(checkSync(root).state, "in-sync");

  write(root, "packages/api/CLAUDE.md", "# API\n\nNo raw SQL.\n");
  applySync(root);
  removeMirror(root);
  assert.deepEqual(snapshot(root), before);
});

test("a hand edit inside the managed block is reported and not overwritten silently", () => {
  const root = richProject();
  applySync(root, { init: true });
  write(root, "AGENTS.md", read(root, "AGENTS.md").replace("Always run the tests.", "Never run the tests."));
  assert.deepEqual(checkSync(root).differences.map((item) => [item.target, item.kind]), [["AGENTS.md", "edited"]]);
  const kept = applySync(root);
  assert.deepEqual(kept.changes, []);
  assert.equal(kept.skipped.length, 1);
  assert.match(read(root, "AGENTS.md"), /Never run the tests\./);
  applySync(root, { overwriteEdited: true });
  assert.match(read(root, "AGENTS.md"), /Always run the tests\./);
  assert.equal(checkSync(root).state, "in-sync");
});

test("a user-defined duet profile or broken settings is a conflict and nothing is written", () => {
  const root = makeTempDir();
  write(root, "CLAUDE.md", "# Rules\n");
  write(root, ".codex/config.toml", '[permissions.duet]\nextends = ":workspace"\n');
  const before = snapshot(root);
  const result = applySync(root, { init: true });
  assert.equal(result.applied, false);
  assert.match(result.conflicts[0], /already defines \[permissions\.duet\]/);
  assert.deepEqual(snapshot(root), before);

  const broken = makeTempDir();
  write(broken, ".claude/settings.json", "{ not json");
  assert.match(applySync(broken, { init: true }).conflicts[0], /not valid JSON/);
});

test("trust problems name the exact fix and only ask for hook trust when a hook is registered", () => {
  const root = richProject();
  applySync(root, { init: true });
  const status = checkSync(root);
  assert.equal(status.hookRegistered, true);
  assert.deepEqual(trustProblems(root, status, null), []);
  assert.match(trustProblems(root, status, { projectTrusted: false, hooks: [] })[0], /does not trust this project/);
  assert.match(trustProblems(root, status, { projectTrusted: true, hooks: [] })[0], /not loaded.*\/hooks/);
  assert.match(trustProblems(root, status, { projectTrusted: true, hooks: [{ command: status.hookCommand, trustStatus: "modified" }] })[0], /is modified/);
  assert.deepEqual(trustProblems(root, status, { projectTrusted: true, hooks: [{ command: status.hookCommand, trustStatus: "trusted" }] }), []);

  const plain = makeTempDir();
  write(plain, "CLAUDE.md", "# Rules\n");
  applySync(plain, { init: true });
  assert.deepEqual(trustProblems(plain, checkSync(plain), { projectTrusted: true, hooks: [] }), []);
});

test("the registered hook command is stable across syncs", () => {
  const root = richProject();
  applySync(root, { init: true });
  const command = buildPlan(root).hookCommand;
  assert.equal(command, `node ${path.join(root, ".duet-workbench/hook-adapter.mjs")}`);
  fs.appendFileSync(path.join(root, "CLAUDE.md"), "\nmore\n");
  write(root, ".claude/settings.json", JSON.stringify({ permissions: { ask: ["Bash(git push:*)", "Bash(terraform apply:*)"] } }));
  applySync(root);
  assert.equal(JSON.parse(read(root, ".codex/hooks.json")).hooks.PreToolUse.at(-1).hooks[0].command, command);
});

// ---------- hook adapter, run the way Codex runs it ----------

function runAdapter(root, event) {
  return spawnSync("node", [path.join(root, ".duet-workbench/hook-adapter.mjs")], {
    input: JSON.stringify({ session_id: "s", turn_id: "t", transcript_path: null, cwd: root, hook_event_name: "PreToolUse", permission_mode: "bypassPermissions", ...event }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: "/wrong/place" }
  });
}

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const patch = (text) => ({ tool_name: "apply_patch", tool_input: { command: text } });

test("adapter blocks commands that need a human and lets others through", () => {
  const root = richProject();
  applySync(root, { init: true });
  for (const command of ["git push origin main", "cd pkg && git push", "FOO=1 git push", "npm publish --tag next", "echo hi; rm -rf build"]) {
    const result = runAdapter(root, bash(command));
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /needs a human/);
  }
  for (const command of ["git status", "git pushx", "npm run build", "echo 'rm -rfx'"]) {
    assert.equal(runAdapter(root, bash(command)).status, 0, command);
  }
  assert.equal(runAdapter(root, { tool_name: "mcp__x__y", tool_input: {} }).status, 0);
});

test("adapter runs the project's guard hook for shell calls and patches", () => {
  const root = richProject();
  applySync(root, { init: true });

  const shell = runAdapter(root, bash("echo TOPSECRET"));
  assert.equal(shell.status, 2);
  assert.match(shell.stderr, /refusing to touch a secret/);

  const target = path.join(root, "src/new.js");
  const bad = runAdapter(root, patch(`*** Begin Patch\n*** Add File: ${target}\n+const key = "TOPSECRET";\n*** End Patch\n`));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /refusing to touch a secret/);

  const ask = runAdapter(root, patch(`*** Begin Patch\n*** Update File: src/old.js\n@@\n-a\n+ASKME\n*** End Patch\n`));
  assert.equal(ask.status, 2);
  assert.match(ask.stderr, /needs approval/);

  const good = runAdapter(root, patch(`*** Begin Patch\n*** Add File: ${target}\n+const a = 1;\n+const b = 2;\n*** End Patch\n`));
  assert.equal(good.status, 0, good.stderr);

  const seen = read(root, "guard-log.jsonl").trim().split("\n").map((line) => JSON.parse(line));
  const last = seen.at(-1);
  assert.equal(last.tool_name, "Write");
  assert.deepEqual(last.tool_input, { file_path: target, content: "const a = 1;\nconst b = 2;" });
  assert.equal(seen[0].tool_name, "Bash");
  assert.equal(seen[2].tool_input.file_path, path.join(root, "src/old.js"));

  const unreadable = runAdapter(root, patch("garbage"));
  assert.equal(unreadable.status, 2);
});

test("adapter treats a worktree of the project as the project (F9)", () => {
  const root = richProject();
  const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  applySync(root, { init: true });
  const worktree = path.join(makeTempDir(), "wt");
  git("worktree", "add", "-q", worktree);

  const target = path.join(worktree, "src/new.js");
  const blocked = runAdapter(root, { cwd: worktree, ...patch(`*** Begin Patch\n*** Add File: ${target}\n+TOPSECRET\n*** End Patch\n`) });
  assert.equal(blocked.status, 2);
  const allowed = runAdapter(root, { cwd: worktree, ...patch(`*** Begin Patch\n*** Add File: ${target}\n+ok\n*** End Patch\n`) });
  assert.equal(allowed.status, 0, allowed.stderr);
  const last = read(root, "guard-log.jsonl").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.equal(last.tool_input.file_path, path.join(fs.realpathSync(root), "src/new.js"));
  assert.equal(last.cwd, fs.realpathSync(root));

  // A different repository is not mapped.
  const other = makeTempDir();
  spawnSync("git", ["init", "-q"], { cwd: other });
  const elsewhere = runAdapter(root, { cwd: other, ...patch(`*** Begin Patch\n*** Add File: ${path.join(other, "x.js")}\n+ok\n*** End Patch\n`) });
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  const outside = read(root, "guard-log.jsonl").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.equal(outside.tool_input.file_path, path.join(other, "x.js"));
});

test("adapter fails closed when its guard file or a mirrored hook is missing", () => {
  const root = richProject();
  applySync(root, { init: true });
  fs.rmSync(path.join(root, ".claude/hooks/guard-secrets.mjs"));
  const missingHook = runAdapter(root, bash("git status"));
  assert.equal(missingHook.status, 2);
  assert.match(missingHook.stderr, /guard hook failed/);

  fs.rmSync(path.join(root, ".duet-workbench/guard.json"));
  const missingGuard = runAdapter(root, bash("git status"));
  assert.equal(missingGuard.status, 2);
  assert.match(missingGuard.stderr, /could not start/);

  const garbage = spawnSync("node", [path.join(root, ".duet-workbench/hook-adapter.mjs")], { input: "not json", encoding: "utf8" });
  assert.equal(garbage.status, 2);
});
