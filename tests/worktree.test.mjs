// F9 (write runs in their own worktree) and the F5 init offer, through the runtime.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { upsertJob } from "../plugins/duet/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "duet", "scripts", "duet-runtime.mjs");

function makeProject(settings = { permissions: { deny: ["Read(./.env)"] } }) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.mkdirSync(path.join(repo, ".claude"));
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify(settings));
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = { ...buildEnv(binDir), DUET_STATE_ROOT: dataDir };
  const duet = (...args) => run("node", [SCRIPT, ...args], { cwd: repo, env });
  const json = (...args) => {
    const result = duet(...args, "--json");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const fakeState = () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  const status = () => run("git", ["status", "--porcelain"], { cwd: repo }).stdout;
  return { repo, duet, json, fakeState, status, dataDir, env };
}

test("write runs each work in their own worktree and never touch the main checkout", () => {
  const { repo, duet, json, fakeState, status } = makeProject();
  duet("sync-apply", "--init");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "mirror"], { cwd: repo });

  const first = json("task", "--write", "FAKE_WRITE:one.txt");
  const second = json("task", "--write", "FAKE_WRITE:two.txt");
  assert.notEqual(first.worktree.path, second.worktree.path);
  assert.deepEqual(first.worktree.files, ["one.txt"]);
  assert.deepEqual(second.worktree.files, ["two.txt"]);
  assert.equal(status(), "", "main checkout untouched");
  // Codex ran inside the worktree, under the project's write profile copied there.
  assert.equal(fakeState().lastThreadParams.cwd, second.worktree.path);
  assert.equal(fakeState().lastThreadParams.config.default_permissions, "duet");
  const toml = fs.readFileSync(path.join(second.worktree.path, ".codex", "config.toml"), "utf8");
  assert.ok(toml.includes(`"${path.join(fs.realpathSync(repo), "**/.env")}" = "deny"`), "main checkout's secrets denied by absolute path");

  const shown = duet("task", "--write", "FAKE_WRITE:three.txt");
  assert.match(shown.stdout, /\[duet\] Codex's changes are on branch duet\/task-[^ ]+, not yet in your files \(1 file\):\n  three\.txt\nApply or discard them: \/duet:result task-/);

  const applied = json("apply", first.worktree.branch.slice("duet/".length));
  assert.deepEqual(applied.applied, ["one.txt"]);
  assert.equal(status(), "A  one.txt\n");
  assert.equal(fs.existsSync(first.worktree.path), false);
  assert.equal(run("git", ["branch", "--list", first.worktree.branch], { cwd: repo }).stdout, "");

  const discarded = json("discard", second.worktree.branch.slice("duet/".length));
  assert.equal(discarded.discarded, second.worktree.branch);
  assert.equal(fs.existsSync(second.worktree.path), false);
  assert.equal(fs.existsSync(path.join(repo, "two.txt")), false);

  const doctor = json("doctor");
  assert.equal(doctor.notes.filter((note) => /not applied or discarded/.test(note)).length, 1, "the third run is still pending");
  assert.match(duet("apply", "nope").stderr, /no unapplied Codex changes for nope/);
});

test("a write run finishes when the copied mirror holds a gitignored file", () => {
  const { repo, duet, json } = makeProject();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".codex/hook-events.log\n");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "ignore"], { cwd: repo });
  // The mirror stays uncommitted and Codex has left an ignored log beside it.
  duet("sync-apply", "--init");
  fs.writeFileSync(path.join(repo, ".codex", "hook-events.log"), "event\n");

  const result = json("task", "--write", "FAKE_WRITE:one.txt");
  assert.deepEqual(result.worktree.files, ["one.txt"], "only the run's own file, not the mirror");
});

test("a read-only follow-up to an unapplied write run looks at that run's copy; history shows the thread", () => {
  const { duet, json, fakeState } = makeProject();
  const first = json("task", "--write", "FAKE_WRITE:one.txt");
  const second = json("task", "--resume-last", "what did you change?");
  assert.equal(fakeState().lastThreadParams.cwd, first.worktree.path);
  assert.equal(second.threadId, first.threadId);
  // The follow-up owns nothing: the first run's changes are still its own to apply.
  assert.deepEqual(json("apply").applied, ["one.txt"]);

  const history = duet("history");
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /## Message 1 of 2\n\n\*\*You:\*\*\n\nfirst question\n\n\*\*Codex:\*\*\n\nfirst answer\n/);
  assert.doesNotMatch(history.stdout, /looking around/, "progress notes are left out");
  assert.match(history.stdout, /second answer/);
});

test("a run is listed by what was asked, is visible project-wide, and can be removed from the list", () => {
  const { repo, duet, json, dataDir } = makeProject();
  json("task", "Goal: explain the cart module\n\nContext: none.");
  const pending = json("task", "--write", "--title", "Add  one\nfile", "FAKE_WRITE:one.txt");
  const pendingId = pending.worktree.branch.slice("duet/".length);

  // Another Claude session sees nothing of these runs unless it asks for the whole project.
  const other = (...args) => JSON.parse(run("node", [SCRIPT, ...args, "--json"], { cwd: repo, env: { ...process.env, DUET_STATE_ROOT: dataDir, DUET_SESSION_ID: "another-session" } }).stdout);
  const all = (snapshot) => [...snapshot.running, snapshot.latestFinished, ...snapshot.recent].filter(Boolean);
  assert.equal(all(other("status", "--all")).length, 0);
  const listed = all(other("status", "--project"));
  assert.equal(listed.length, 2);
  const kept = listed.find((job) => job.id !== pendingId);
  assert.equal(kept.title, "explain the cart module");
  // A name given with --title wins over the prompt's start, on one line.
  assert.equal(listed.find((job) => job.id === pendingId).title, "Add one file");

  // Removing a run with unapplied changes drops its worktree and branch too.
  assert.equal(json("forget", pendingId).forgotten, true);
  assert.equal(fs.existsSync(pending.worktree.path), false);
  assert.equal(run("git", ["branch", "--list", pending.worktree.branch], { cwd: repo }).stdout, "");
  assert.deepEqual(all(json("status", "--project")).map((job) => job.id), [kept.id]);
  assert.match(duet("result", pendingId).stderr, /No job found/);
  assert.match(duet("forget", "nope").stderr, /No Codex run "nope"/);
});

test("a write run with no changes leaves no worktree; uncommitted work is named", () => {
  const { repo, json, duet } = makeProject();
  fs.writeFileSync(path.join(repo, "draft.txt"), "mine\n");
  const result = duet("task", "--write", "look only", "--json");
  assert.match(result.stderr, /your 1 uncommitted change is not included/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.worktree.state, "empty");
  assert.equal(fs.existsSync(payload.worktree.path), false);
  assert.match(duet("apply").stderr, /no unapplied Codex changes in this repository/);
});

test("a resumed write run continues in the previous run's worktree", () => {
  const { json } = makeProject();
  const first = json("task", "--write", "FAKE_WRITE:one.txt");
  const resumed = json("task", "--write", "--resume-last", "FAKE_WRITE:two.txt");
  assert.equal(resumed.worktree.path, first.worktree.path);
  assert.deepEqual(resumed.worktree.files, ["one.txt", "two.txt"]);
});

test("a background write run gets its worktree before it is queued", () => {
  const { json } = makeProject();
  const queued = json("task", "--write", "--background", "FAKE_WRITE:bg.txt");
  const done = json("status", queued.jobId, "--wait", "--timeout-ms", "30000");
  assert.equal(done.job.status, "completed", JSON.stringify(done.job));
  assert.deepEqual(done.job.worktree.files, ["bg.txt"]);
});

test("--here writes in place, one such run at a time", () => {
  const { repo, json, duet, dataDir } = makeProject();
  json("task", "--write", "--here", "FAKE_WRITE:here.txt");
  assert.equal(fs.existsSync(path.join(repo, "here.txt")), true);

  // An in-place write run that is still running blocks a second one, but not a worktree run.
  process.env.DUET_STATE_ROOT = dataDir;
  try {
    upsertJob(repo, { id: "task-busy", status: "running", write: true, jobClass: "task" });
  } finally {
    delete process.env.DUET_STATE_ROOT;
  }
  const second = duet("task", "--write", "--here", "again");
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Another write run \(task-busy\) is working in this folder/);
  assert.equal(duet("task", "--write", "again").status, 0);
});

test("result of a running job says it is still running, not that it does not exist", () => {
  const { repo, duet, dataDir } = makeProject();
  process.env.DUET_STATE_ROOT = dataDir;
  try {
    upsertJob(repo, { id: "task-live", status: "running", jobClass: "task" });
  } finally {
    delete process.env.DUET_STATE_ROOT;
  }
  const result = duet("result", "task-live");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Job task-live is still running/);
});

test("setup is offered only where there are security rules, and a decline sticks without touching the project", () => {
  const withRules = makeProject({ permissions: { deny: ["Read(./.env)"], ask: ["Bash(git push:*)"] } });
  const offer = withRules.json("init-offer");
  assert.equal(offer.offer, true);
  assert.deepEqual(offer.rules, ["permissions.deny: Read(./.env)", "permissions.ask: Bash(git push:*)"]);
  withRules.json("init-offer", "--decline", "never");
  assert.equal(withRules.json("init-offer").offer, false);
  assert.equal(withRules.status(), "", "nothing written into the project");

  const notNow = makeProject();
  notNow.json("init-offer", "--decline", "session");
  assert.equal(notNow.json("init-offer").offer, false);

  const plain = makeProject({});
  assert.equal(plain.json("init-offer").offer, false, "a project without rules is not interrupted");

  const initialised = makeProject();
  initialised.duet("sync-apply", "--init");
  assert.equal(initialised.json("init-offer").offer, false);
});

test("shell metacharacters in a task reach Codex as text and never run", () => {
  const { repo, env, fakeState } = makeProject();
  const prompt = "check $(touch PWNED-SUB) and `touch PWNED-TICK`; touch PWNED-SEMI && touch PWNED-AND | touch PWNED-PIPE";
  const ran = run("node", [SCRIPT, "task", "--json"], { cwd: repo, env, input: prompt });
  assert.equal(ran.status, 0, ran.stderr || ran.stdout);

  assert.ok(fakeState().lastTurnStart.prompt.includes(prompt), "the prompt reached Codex unchanged");
  const created = fs.readdirSync(repo).filter((name) => name.startsWith("PWNED"));
  assert.deepEqual(created, []);
});

test("a write run whose changes conflict is not applied, and the user's work and Codex's are both kept", () => {
  const { repo, json, duet } = makeProject();
  const result = json("task", "--write", "FAKE_WRITE:README.md");
  fs.writeFileSync(path.join(repo, "README.md"), "my own edit\n");
  run("git", ["commit", "-am", "mine"], { cwd: repo });

  const applied = duet("apply", result.worktree.branch.slice("duet/".length));
  assert.notEqual(applied.status, 0);
  assert.match(applied.stderr, /conflict with your branch in: README\.md\. Nothing was changed\./);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "my own edit\n");
  assert.equal(run("git", ["status", "--porcelain"], { cwd: repo }).stdout, "");
  assert.ok(fs.existsSync(result.worktree.path), "Codex's worktree is kept");
  assert.notEqual(run("git", ["branch", "--list", result.worktree.branch], { cwd: repo }).stdout, "", "and its branch");
});

test("a write run is not applied over the user's uncommitted file of the same name", () => {
  const { repo, json, duet } = makeProject();
  const result = json("task", "--write", "FAKE_WRITE:one.txt");
  fs.writeFileSync(path.join(repo, "one.txt"), "not committed yet\n");

  const applied = duet("apply", result.worktree.branch.slice("duet/".length));
  assert.notEqual(applied.status, 0);
  assert.match(applied.stderr, /Could not apply duet\/.*Commit or stash your own edits/s);
  assert.equal(fs.readFileSync(path.join(repo, "one.txt"), "utf8"), "not committed yet\n");
  assert.ok(fs.existsSync(result.worktree.path), "Codex's worktree is kept");
});
