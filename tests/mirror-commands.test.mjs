import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "duet", "scripts", "duet-runtime.mjs");

function makeProject(behavior, settings = { permissions: { deny: ["Read(./.env)"], ask: ["Bash(git push:*)"] } }) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# Rules\n\nRun the tests.\n");
  fs.mkdirSync(path.join(repo, ".claude"));
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify(settings));
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const duet = (...args) => run("node", [SCRIPT, ...args], { cwd: repo, env: buildEnv(binDir) });
  const statePath = path.join(binDir, "fake-codex-state.json");
  const fakeState = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {});
  return { repo, duet, fakeState };
}

test("init, check, doctor and remove work headless through the runtime", () => {
  const { repo, duet } = makeProject();
  assert.equal(JSON.parse(duet("sync-check", "--json").stdout).state, "not-initialised");

  const preview = JSON.parse(duet("sync-apply", "--init", "--dry-run", "--json").stdout);
  assert.equal(preview.applied, false);
  assert.equal(fs.existsSync(path.join(repo, "AGENTS.md")), false);

  const init = JSON.parse(duet("sync-apply", "--init", "--json").stdout);
  assert.equal(init.applied, true);
  assert.equal(init.nextSteps.length, 2);
  assert.match(init.nextSteps[1], /\/hooks/);
  assert.equal(JSON.parse(duet("sync-check", "--json").stdout).state, "in-sync");

  const doctor = JSON.parse(duet("doctor", "--json").stdout);
  assert.equal(doctor.ok, true, JSON.stringify(doctor.prerequisites));
  assert.deepEqual(doctor.prerequisites.map((item) => item.name), ["Codex CLI", "Signed in to Codex", "Project trusted in Codex", "Guard hook trusted in Codex"]);
  assert.ok(doctor.coverage.every((rule) => rule.outcome && rule.how));
  assert.match(duet("doctor").stdout, /Prerequisites[\s\S]*Drift[\s\S]*Coverage/);

  fs.appendFileSync(path.join(repo, "CLAUDE.md"), "\nNew rule.\n");
  const drifted = JSON.parse(duet("doctor", "--json").stdout);
  assert.equal(drifted.ok, false);
  assert.deepEqual(drifted.drift.changedSources, ["CLAUDE.md"]);
  assert.equal(JSON.parse(duet("sync-apply", "--json").stdout).changes.length, 1);
  assert.equal(JSON.parse(duet("doctor", "--json").stdout).ok, true);

  assert.match(duet("remove", "--dry-run").stdout, /would delete AGENTS\.md/);
  duet("remove");
  // Only the test's own edit to CLAUDE.md is left.
  assert.equal(run("git", ["status", "--porcelain"], { cwd: repo }).stdout, " M CLAUDE.md\n");
});

test("a delegation syncs a stale mirror first and runs under the project's duet profile", () => {
  const { repo, duet, fakeState } = makeProject();
  duet("sync-apply", "--init");
  fs.appendFileSync(path.join(repo, "CLAUDE.md"), "\nNever force-push.\n");

  const result = duet("task", "look around");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /synced this project's rules for Codex \(AGENTS\.md\)/);
  assert.match(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /Never force-push\./);
  assert.equal(fakeState().lastThreadParams.config.default_permissions, "duet-read");
});

test("with auto sync off, a stale mirror blocks the delegation", () => {
  const { repo, duet, fakeState } = makeProject();
  duet("sync-apply", "--init");
  fs.writeFileSync(path.join(repo, ".duet-workbench", "config.json"), JSON.stringify({ auto: "off" }));
  fs.appendFileSync(path.join(repo, "CLAUDE.md"), "\nNever force-push.\n");
  const result = duet("task", "look around");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /out of date.*Run \/duet:sync/);
  assert.equal(fakeState().lastTurnStart, undefined);
});

test("an untrusted project or guard hook stops the delegation with the fix", () => {
  const untrustedProject = makeProject("project-untrusted");
  untrustedProject.duet("sync-apply", "--init");
  const first = untrustedProject.duet("task", "look around");
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /does not trust this project/);
  assert.equal(untrustedProject.fakeState().lastTurnStart, undefined);
  const doctor = JSON.parse(untrustedProject.duet("doctor", "--json").stdout);
  assert.deepEqual(doctor.prerequisites.filter((item) => !item.ok).map((item) => item.name), ["Project trusted in Codex", "Guard hook trusted in Codex"]);

  const untrustedHook = makeProject("hook-untrusted");
  untrustedHook.duet("sync-apply", "--init");
  const second = untrustedHook.duet("review");
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /guard hook is untrusted.*\/hooks/);

  // Nothing to guard → no hook registered → hook trust is not required.
  const noHook = makeProject("hook-untrusted", { permissions: { deny: ["Read(./.env)"] } });
  noHook.duet("sync-apply", "--init");
  const third = noHook.duet("task", "look around");
  assert.equal(third.status, 0, third.stderr);
});

test("a project that was never initialised delegates as before and gets no files", () => {
  const { repo, duet, fakeState } = makeProject("project-untrusted");
  const result = duet("task", "look around");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState().lastThreadParams.config.default_permissions, ":read-only");
  assert.equal(run("git", ["status", "--porcelain"], { cwd: repo }).stdout, "");
});
