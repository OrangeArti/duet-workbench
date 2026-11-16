import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolvePermissionProfile } from "../plugins/duet/scripts/lib/codex.mjs";
import { describeValidChoices, loadModelCatalog, resolveModelAlias } from "../plugins/duet/scripts/lib/models.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "duet");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "duet-runtime.mjs");

// One fake Codex per repo: runs in the same repo share one app-server broker.
const fakeBins = new Map();

function makeRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fakeBins.set(repo, binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function runTask(repo, args) {
  const binDir = fakeBins.get(repo);
  const result = run("node", [SCRIPT, "task", ...args], { cwd: repo, env: buildEnv(binDir) });
  const statePath = path.join(binDir, "fake-codex-state.json");
  return { result, state: JSON.parse(fs.readFileSync(statePath, "utf8")) };
}

function initDuetProfiles(repo) {
  fs.mkdirSync(path.join(repo, ".codex"));
  fs.writeFileSync(
    path.join(repo, ".codex", "config.toml"),
    'default_permissions = "duet-read"\n[permissions.duet-read]\nextends = ":read-only"\n[permissions.duet]\nextends = ":workspace"\n'
  );
}

test("task never sends the legacy sandbox param and picks a built-in profile", () => {
  const repo = makeRepo();
  const readOnly = runTask(repo, ["look around"]);
  assert.equal(readOnly.result.status, 0, readOnly.result.stderr);
  assert.equal("sandbox" in readOnly.state.lastThreadParams, false);
  assert.deepEqual(readOnly.state.lastThreadParams.config, { default_permissions: ":read-only" });

  const write = runTask(repo, ["--write", "fix it"]);
  assert.equal("sandbox" in write.state.lastThreadParams, false);
  assert.deepEqual(write.state.lastThreadParams.config, { default_permissions: ":workspace" });
});

test("task uses the project's duet profiles when the project is initialised", () => {
  const repo = makeRepo();
  initDuetProfiles(repo);
  assert.equal(runTask(repo, ["look around"]).state.lastThreadParams.config.default_permissions, "duet-read");
  assert.equal(runTask(repo, ["--write", "fix it"]).state.lastThreadParams.config.default_permissions, "duet");
});

test("no code path can select danger-full-access", () => {
  const repo = makeRepo();
  const plain = [resolvePermissionProfile(repo, false), resolvePermissionProfile(repo, true)];
  initDuetProfiles(repo);
  const all = [...plain, resolvePermissionProfile(repo, false), resolvePermissionProfile(repo, true)];
  assert.deepEqual(all, [":read-only", ":workspace", "duet-read", "duet"]);

  const scripts = path.join(PLUGIN_ROOT, "scripts");
  for (const file of fs.readdirSync(scripts, { recursive: true })) {
    const full = path.join(scripts, file);
    if (fs.statSync(full).isFile()) {
      assert.doesNotMatch(fs.readFileSync(full, "utf8"), /danger-full-access|dangerFullAccess/, file);
    }
  }
});

test("aliases resolve and unknown models and efforts still reach Codex", () => {
  assert.equal(resolveModelAlias("Luna"), "gpt-6-luna");
  const repo = makeRepo();
  const alias = runTask(repo, ["--model", "astra", "--effort", "ultra", "go"]);
  assert.equal(alias.state.lastTurnStart.model, "gpt-6-astra");
  assert.equal(alias.state.lastTurnStart.effort, "ultra");

  const unknown = runTask(repo, ["--model", "some-future-model", "--effort", "hyper", "go"]);
  assert.equal(unknown.result.status, 0, unknown.result.stderr);
  assert.equal(unknown.state.lastTurnStart.model, "some-future-model");
  assert.equal(unknown.state.lastTurnStart.effort, "hyper");
});

test("models --json returns the live list from Codex, marked with its source", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const result = run("node", [SCRIPT, "models", "--json"], { cwd: makeRepo(), env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(result.stdout);
  assert.equal(catalog.source, "codex");
  assert.deepEqual(catalog.models.map((model) => model.id), ["fake-live-model"]);
  assert.deepEqual(catalog.models[0].efforts, ["low", "ultra"]);
  assert.equal(catalog.aliases.sol, "gpt-6.1-sol");
});

test("models falls back to models.json when Codex cannot list models", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-list-fails");
  const result = run("node", [SCRIPT, "models", "--json"], { cwd: makeRepo(), env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(result.stdout);
  const bundled = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "models.json"), "utf8"));
  assert.equal(catalog.source, "fallback");
  assert.equal(catalog.checked, bundled.checked);
  assert.deepEqual(catalog.models.map((model) => model.id), bundled.models.map((model) => model.id));
});

test("changing models.json alone changes the fallback catalog and the failure hint", async () => {
  const catalogPath = path.join(makeTempDir(), "models.json");
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({ checked: "2030-01-01", aliases: { nova: "gpt-9-nova" }, models: [{ id: "gpt-9-nova", isDefault: true, efforts: ["low", "mega"] }] })
  );
  const catalog = await loadModelCatalog("/nowhere", {
    catalogPath,
    list: async () => {
      throw new Error("no codex");
    }
  });
  assert.equal(catalog.source, "fallback");
  assert.equal(catalog.checked, "2030-01-01");
  assert.deepEqual(catalog.models.map((model) => model.id), ["gpt-9-nova"]);
  assert.equal(resolveModelAlias("nova", catalogPath), "gpt-9-nova");
  assert.match(describeValidChoices("gpt-9-nova", catalogPath), /gpt-9-nova.*aliases: nova.*Efforts for gpt-9-nova: low, mega/);
});

test("errors are also printed as JSON when --json is passed", () => {
  const result = run("node", [SCRIPT, "result", "no-such-job", "--json"], { cwd: makeRepo(), env: process.env });
  assert.notEqual(result.status, 0);
  assert.equal(typeof JSON.parse(result.stdout).error, "string");
});
