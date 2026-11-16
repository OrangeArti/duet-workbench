import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TASK_TYPES, shapePrompt } from "../plugins/duet/scripts/lib/shape.mjs";

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), "../plugins/duet/scripts/duet-runtime.mjs");

test("every task type previews Goal, Context, Constraints, Done when, autonomy, verification and report", () => {
  assert.deepEqual(TASK_TYPES.map((type) => type.value), ["implement", "diagnose", "review", "research", "audit"]);
  for (const { value } of TASK_TYPES) {
    const prompt = shapePrompt({ type: value, task: "make the thing work" });
    for (const part of ["Goal: make the thing work", "Context: ", "Constraints: Read-only.", "Done when: ", "Work without asking me questions", "Verification: ", "Report back with: "]) {
      assert.ok(prompt.includes(part), `${value}: ${part}`);
    }
  }
  assert.match(shapePrompt({ task: "x", write: true }), /Constraints: You may edit files/);
  assert.throws(() => shapePrompt({ type: "nope", task: "x" }), /Unknown task type/);
  assert.throws(() => shapePrompt({ task: " " }), /Write the task first/);
});

test("shape reads the task from stdin and starts nothing", () => {
  const ran = spawnSync(process.execPath, [RUNTIME, "shape", "--type", "review", "--json"], { input: "check `$(whoami)`", encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(JSON.parse(ran.stdout).prompt, /^Goal: check `\$\(whoami\)`\n/);
});

test("auto picks the recipe from the task's words and falls back to implement", async () => {
  const { inferType } = await import("../plugins/duet/scripts/lib/shape.mjs");
  assert.equal(inferType("why does the login test fail"), "diagnose");
  assert.equal(inferType("Сделай ревью изменений"), "review");
  assert.equal(inferType("how does the sync engine work?"), "research");
  assert.equal(inferType("add a --json flag to doctor"), "implement");
  assert.equal(shapePrompt({ type: "auto", task: "audit the hooks" }), shapePrompt({ type: "audit", task: "audit the hooks" }));
});

test("--access auto gives write only to a task that changes files", () => {
  const shape = (task, ...args) =>
    JSON.parse(spawnSync(process.execPath, [RUNTIME, "shape", "--json", ...args], { input: task, encoding: "utf8" }).stdout);

  const fix = shape("add a --json flag to doctor", "--type", "auto", "--access", "auto");
  assert.equal(fix.write, true);
  assert.match(fix.prompt, /Constraints: You may edit files/);

  const why = shape("why does the login test fail", "--type", "auto", "--access", "auto");
  assert.equal(why.write, false);
  assert.match(why.prompt, /Constraints: Read-only\./);

  // An explicit choice wins over the task's words, both ways.
  assert.equal(shape("add a --json flag to doctor", "--type", "auto", "--access", "read").write, false);
  assert.equal(shape("why does the login test fail", "--type", "diagnose", "--access", "write").write, true);
  assert.equal(shape("review the diff", "--type", "review", "--access", "auto").write, false);

  // Russian, and the unsure cases: a fix named next to a failure writes; no change asked means read-only.
  const auto = (task) => shape(task, "--type", "auto", "--access", "auto").write;
  assert.equal(auto("почини баг со скидкой в src/cart.mjs, тест падает"), true);
  assert.equal(auto("почему падает тест в tests/cart.test.mjs?"), false);
  assert.equal(auto("опиши структуру проекта"), false);
  assert.equal(auto("сделай ревью изменений"), false);
  assert.equal(auto("explain how to add a flag"), false);
  // A type picked by hand decides on its own.
  assert.equal(shape("look around", "--type", "implement", "--access", "auto").write, true);
});
