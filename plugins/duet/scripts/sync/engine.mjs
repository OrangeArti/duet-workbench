// The project mirror: Claude-side files are read-only sources, Codex-side files are generated.
// See docs/sync-mapping.md. The mirror only ever adds restrictions.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getRegion, removeRegion, setRegion } from "./managed.mjs";

const STATE_DIR = ".duet-workbench";
const LEDGER_REL = `${STATE_DIR}/state.json`;
const CONFIG_REL = `${STATE_DIR}/config.json`;
const GUARD_REL = `${STATE_DIR}/guard.json`;
const ADAPTER_REL = `${STATE_DIR}/hook-adapter.mjs`;
const TOML_REL = ".codex/config.toml";
const HOOKS_REL = ".codex/hooks.json";
const ADAPTER_SOURCE = fileURLToPath(new URL("../hook-adapter.mjs", import.meta.url));
const DEFAULT_BUDGET = 32768;
const MAX_BUDGET = 65536;
const GUARDED_TOOLS = ["Bash", "Edit", "Write", "MultiEdit"];
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const SELF_PROTECTED = [".codex", ".duet-workbench", ".claude", "AGENTS.md"];

export const DEFAULT_PROJECT_CONFIG = {
  auto: "auto",
  excludeHeadings: [],
  mirrorNetwork: false,
  mirrorExternalHooks: []
};

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = fs.existsSync(file) ? fs.statSync(file).mode : null;
  const temp = `${file}.duet-workbench-tmp`;
  fs.writeFileSync(temp, text);
  if (mode != null) {
    fs.chmodSync(temp, mode);
  }
  fs.renameSync(temp, file);
}

export function isInitialised(root) {
  return fs.existsSync(path.join(root, LEDGER_REL));
}

function readLedger(root) {
  const text = read(path.join(root, LEDGER_REL));
  return text ? JSON.parse(text) : null;
}

export function readProjectConfig(root) {
  const text = read(path.join(root, CONFIG_REL));
  return { ...DEFAULT_PROJECT_CONFIG, ...(text ? JSON.parse(text) : {}) };
}

// ---------- sources ----------

function findClaudeDirs(root, dir = "", found = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "CLAUDE.md") {
      found.push(dir);
    } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      findClaudeDirs(root, path.join(dir, entry.name), found);
    }
  }
  return found;
}

function parseRule(rule) {
  const match = /^([A-Za-z_][\w-]*)(?:\(([\s\S]*)\))?$/.exec(String(rule).trim());
  return match ? { tool: match[1], arg: match[2] ?? null } : { tool: String(rule), arg: null };
}

// Claude path rule → Codex filesystem key. Patterns without a slash match at any depth in Claude,
// so they become `**/name` (never narrower than the source rule).
function normalisePath(arg) {
  if (arg.startsWith("//")) {
    return { scope: "outside", key: arg.slice(1) };
  }
  if (arg === "~" || arg.startsWith("~/")) {
    return { scope: "outside", key: arg };
  }
  const relative = arg.replace(/^\.?\//, "");
  return { scope: "workspace", key: relative.includes("/") ? relative : `**/${relative}` };
}

function matchedTools(matcher) {
  if (!matcher || matcher === "*") {
    return GUARDED_TOOLS;
  }
  try {
    const pattern = new RegExp(`^(?:${matcher})$`);
    return GUARDED_TOOLS.filter((tool) => pattern.test(tool));
  } catch {
    return [];
  }
}

// shortcut: splits the hook command on whitespace, so script paths with spaces are not
// recognised as in-project; quote-aware parsing when a real project needs it.
function projectScripts(command, root) {
  const scripts = [];
  for (const raw of String(command).split(/\s+/)) {
    const token = raw.replace(/^["']|["']$/g, "").replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, root);
    if (!token || token.startsWith("-")) {
      continue;
    }
    const full = path.resolve(root, token);
    const rel = path.relative(root, full);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      scripts.push(rel);
    }
  }
  return scripts;
}

function buildRestrictions(settings, config, root) {
  const rules = [];
  const workspace = new Map();
  const outside = new Map();
  const deny = [];
  const hooks = [];
  const needsHuman = [];
  const scripts = [];
  let network = null;

  const setPath = (arg, level) => {
    const { scope, key } = normalisePath(arg);
    const map = scope === "workspace" ? workspace : outside;
    if (map.get(key) !== "deny") {
      map.set(key, level);
    }
    // `dir/**` alone leaves the directory listable in Codex (file names leak): deny the directory too.
    if (level === "deny" && /[^*/]\/\*\*$/.test(key)) {
      map.set(key.slice(0, -3), "deny");
    }
  };

  for (const kind of ["deny", "ask"]) {
    for (const rule of settings?.permissions?.[kind] ?? []) {
      const { tool, arg } = parseRule(rule);
      const label = `permissions.${kind}: ${rule}`;
      if (kind === "ask") {
        needsHuman.push(`\`${rule}\` — Claude Code asks a human before doing this`);
      }
      if (tool === "Read" && arg) {
        setPath(arg, "deny");
        rules.push({ rule: label, outcome: "enforced", how: "filesystem deny in the Codex permission profile" });
      } else if (FILE_TOOLS.has(tool) && arg) {
        setPath(arg, "read");
        rules.push({ rule: label, outcome: "enforced", how: "path is read-only in the Codex permission profile" });
      } else if (tool === "Bash") {
        deny.push({ pattern: arg ?? "*", rule, kind });
        rules.push({ rule: label, outcome: "enforced", how: "blocked by the duet-workbench hook (the hook must be trusted in Codex)" });
      } else {
        if (kind === "deny") {
          needsHuman.push(`\`${rule}\` — forbidden in this project`);
        }
        rules.push({ rule: label, outcome: "instruction-only", how: "Codex has no mechanism for this tool; listed under \"Needs a human\"" });
      }
    }
  }

  const sandbox = settings?.sandbox ?? {};
  if (sandbox.enabled) {
    rules.push({ rule: "sandbox.enabled", outcome: "enforced", how: "delegated Codex runs are always sandboxed" });
  }
  const domains = sandbox.network?.allowedDomains ?? [];
  if (domains.length) {
    if (config.mirrorNetwork) {
      network = { domains, allowLocalBinding: Boolean(sandbox.network.allowLocalBinding) };
      rules.push({ rule: "sandbox.network.allowedDomains", outcome: "enforced", how: "network allowlist in the profile (opted in; enforcement of the list is not canary-tested yet)" });
    } else {
      rules.push({ rule: "sandbox.network.allowedDomains", outcome: "not mirrored", how: "Codex runs with network off, which is stricter; set mirrorNetwork in .duet-workbench/config.json to allow these domains" });
    }
  }
  if (sandbox.network?.allowLocalBinding != null) {
    rules.push({ rule: "sandbox.network.allowLocalBinding", outcome: config.mirrorNetwork && network ? "enforced" : "not mirrored", how: config.mirrorNetwork && network ? "network option in the profile" : "network is off for Codex" });
  }
  for (const key of ["excludedCommands", "allowUnsandboxedCommands"]) {
    if (sandbox[key] != null) {
      rules.push({ rule: `sandbox.${key}`, outcome: "not mirrored", how: "Codex has no per-command sandbox escape in delegated runs (stricter by default)" });
    }
  }

  for (const [event, entries] of Object.entries(settings?.hooks ?? {})) {
    if (event !== "PreToolUse") {
      rules.push({ rule: `hooks.${event}`, outcome: "not mirrored", how: "only PreToolUse guards are mirrored" });
      continue;
    }
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        const label = `hooks.PreToolUse[${entry.matcher || "*"}]: ${hook.command ?? hook.type}`;
        const tools = matchedTools(entry.matcher);
        const hookScripts = hook.type === "command" ? projectScripts(hook.command, root) : [];
        const inProject = hookScripts.length > 0 || /\$\{?CLAUDE_PROJECT_DIR/.test(hook.command ?? "");
        if (hook.type !== "command") {
          rules.push({ rule: label, outcome: "not mirrored", how: "only command hooks are mirrored" });
        } else if (tools.length === 0) {
          rules.push({ rule: label, outcome: "not mirrored", how: "no equivalent: Codex exposes only shell and patch calls to hooks; file reads are covered by filesystem denies" });
        } else if (!inProject && !config.mirrorExternalHooks.includes(hook.command)) {
          rules.push({ rule: label, outcome: "not mirrored", how: "external command; add it to mirrorExternalHooks in .duet-workbench/config.json to opt in" });
        } else {
          hooks.push({ matcher: entry.matcher || "*", command: hook.command, timeout: hook.timeout ?? null });
          scripts.push(...hookScripts);
          rules.push({ rule: label, outcome: "enforced", how: "run through the duet-workbench hook (the hook must be trusted in Codex)" });
        }
      }
    }
  }

  return { rules, workspace, outside, deny, hooks, needsHuman, scripts, network };
}

// ---------- generated content ----------

const toml = (value) => JSON.stringify(value);

function renderProfile(id, base, description, restrictions, write, protectedPaths, checkoutRoot = null) {
  const lines = [`[permissions.${id}]`, `description = ${toml(description)}`, `extends = ${toml(base)}`];
  const outside = [...restrictions.outside].filter(([, level]) => write || level === "deny");
  const inside = [...restrictions.workspace].filter(([, level]) => write || level === "deny");
  if (checkoutRoot) {
    // F9: a run in a worktree must not read the main checkout's secrets by absolute path.
    outside.push(...inside.filter(([, level]) => level === "deny").map(([key]) => [path.join(checkoutRoot, key), "deny"]));
  }
  if (write) {
    inside.unshift([".", "write"]);
    for (const key of protectedPaths) {
      if (!restrictions.workspace.has(key)) {
        inside.push([key, "read"]);
      }
    }
  }
  if (outside.length) {
    lines.push("", `[permissions.${id}.filesystem]`, ...outside.map(([key, level]) => `${toml(key)} = ${toml(level)}`));
  }
  if (inside.length) {
    lines.push("", `[permissions.${id}.filesystem.":workspace_roots"]`, ...inside.map(([key, level]) => `${toml(key)} = ${toml(level)}`));
  }
  if (restrictions.network) {
    lines.push(
      "",
      `[permissions.${id}.network]`,
      "enabled = true",
      `allow_local_binding = ${restrictions.network.allowLocalBinding}`,
      "",
      `[permissions.${id}.network.domains]`,
      ...restrictions.network.domains.map((domain) => `${toml(domain)} = "allow"`)
    );
  }
  return lines.join("\n");
}

function dropHeadings(markdown, names) {
  if (!names.length) {
    return markdown;
  }
  const wanted = new Set(names.map((name) => name.trim().toLowerCase()));
  const kept = [];
  let skipLevel = 0;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
    }
    const heading = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (skipLevel && heading[1].length <= skipLevel) {
        skipLevel = 0;
      }
      if (!skipLevel && wanted.has(heading[2].toLowerCase())) {
        skipLevel = heading[1].length;
      }
    }
    if (!skipLevel) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

const POINTER = "Before you start, read `CLAUDE.md` in this directory in full. It holds the rules for this part of the project and is too large to copy here.";

function rootBlock(body, needsHuman, pointer) {
  return [
    "## Rules mirrored from Claude Code (managed by duet-workbench)",
    "",
    "This block is generated from `CLAUDE.md` and `.claude/settings.json`. Do not edit it here; edit those files and sync.",
    "",
    "These rules were written for Claude Code and apply to you as well. Read \"Claude Code\", \"Claude\" and \"you\" as yourself. Where a rule names a tool, skill or plugin that exists only in Claude Code, follow its intent with your own tools.",
    "",
    "### When duet-workbench runs you as a worker",
    "",
    "Nobody can answer questions during the run. If a step needs a decision or an approval you do not have, stop and report it instead of guessing. Never perform the actions listed under \"Needs a human\"; report that they are needed. Finish with the report shape the task asks for.",
    "",
    "### Needs a human",
    "",
    ...(needsHuman.length ? needsHuman.map((item) => `- ${item}`) : ["Nothing is listed for this project."]),
    "",
    "### Project rules (from `CLAUDE.md`)",
    "",
    pointer ? POINTER : body == null ? "This project has no `CLAUDE.md` at its root." : body.trim()
  ].join("\n");
}

function nestedBlock(body, pointer) {
  return [
    "## Rules for this directory, mirrored from `CLAUDE.md` (managed by duet-workbench)",
    "",
    pointer ? POINTER : body.trim()
  ].join("\n");
}

function hookCommand(root) {
  const adapter = path.join(root, ADAPTER_REL);
  return `node ${/^[\w@%+=:,./-]+$/.test(adapter) ? adapter : JSON.stringify(adapter)}`;
}

const isAdapterEntry = (entry) => (entry?.hooks ?? []).some((hook) => String(hook?.command ?? "").includes(ADAPTER_REL));

function hooksTarget(root, registered) {
  const entry = registered ? { matcher: "*", hooks: [{ type: "command", command: hookCommand(root) }] } : null;
  return {
    rel: HOOKS_REL,
    desired: entry ? JSON.stringify(entry) : null,
    managed(current) {
      const found = (JSON.parse(current || "{}").hooks?.PreToolUse ?? []).find(isAdapterEntry);
      return found ? JSON.stringify(found) : null;
    },
    apply(current) {
      const data = JSON.parse(current || "{}");
      const list = (data.hooks?.PreToolUse ?? []).filter((item) => !isAdapterEntry(item));
      if (entry) {
        list.push(entry);
      }
      return stringifyHooks(data, list);
    }
  };
}

function stringifyHooks(data, list) {
  const hooks = { ...(data.hooks ?? {}) };
  if (list.length) {
    hooks.PreToolUse = list;
  } else {
    delete hooks.PreToolUse;
  }
  const next = { ...data, hooks };
  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  }
  return Object.keys(next).length ? `${JSON.stringify(next, null, 2)}\n` : "";
}

function fileTarget(rel, content) {
  return { rel, desired: content, managed: (current) => current, apply: () => content };
}

function regionTarget(rel, style, regions) {
  const extract = (current) => regions.map((region) => getRegion(current, style, region.id));
  return {
    rel,
    desired: JSON.stringify(regions.map((region) => region.body)),
    managed(current) {
      const found = extract(current);
      return found.every((body) => body == null) ? null : JSON.stringify(found);
    },
    apply: (current) => regions.reduce((text, region) => setRegion(text, style, region.id, region.body, region.position), current ?? "")
  };
}

// ---------- plan ----------

export function buildPlan(root, { checkoutRoot = null } = {}) {
  const config = readProjectConfig(root);
  const conflicts = [];
  const notes = [];
  const sources = {};
  const settingsText = read(path.join(root, ".claude/settings.json"));
  let settings = null;
  if (settingsText != null) {
    sources[".claude/settings.json"] = sha(settingsText);
    try {
      settings = JSON.parse(settingsText);
    } catch (error) {
      conflicts.push(`.claude/settings.json is not valid JSON (${error.message}); fix it before syncing, otherwise its restrictions cannot be mirrored.`);
    }
  }
  const restrictions = buildRestrictions(settings, config, root);
  for (const script of new Set(restrictions.scripts)) {
    sources[script] = sha(read(path.join(root, script)) ?? "");
  }
  const rules = [...restrictions.rules];

  const currentToml = read(path.join(root, TOML_REL)) ?? "";
  const userToml = removeRegion(removeRegion(currentToml, "toml", "profiles", "end"), "toml", "keys", "top");
  if (/^\s*\[\s*permissions\.(?:duet|duet-read)\s*[.\]]/m.test(userToml)) {
    conflicts.push(`${TOML_REL} already defines [permissions.duet] or [permissions.duet-read] outside the managed block; rename or remove that table, then sync again.`);
  }
  // shortcut: top-level keys are found line by line, so a key inside a multi-line string or array
  // above the first table could be misread; swap in a TOML parser if that bites.
  const userKeys = new Map();
  for (const line of userToml.split(/^\s*\[/m)[0].split("\n")) {
    const match = /^\s*"?([A-Za-z0-9_-]+)"?\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (match) {
      userKeys.set(match[1], match[2]);
    }
  }
  // The project's own project_doc_max_bytes is kept, so it is the ceiling: what does not fit
  // under it goes to pointer mode instead of being cut short by Codex.
  const userLimit = Number(userKeys.get("project_doc_max_bytes"));
  const budget = userLimit > 0 ? Math.min(MAX_BUDGET, userLimit) : MAX_BUDGET;

  // Instructions.
  const dirs = findClaudeDirs(root);
  if (!dirs.includes("")) {
    dirs.unshift("");
  }
  const files = dirs.map((dir) => {
    const rel = path.join(dir, "AGENTS.md");
    const sourceRel = path.join(dir, "CLAUDE.md");
    const sourceText = read(path.join(root, sourceRel));
    if (sourceText != null) {
      sources[sourceRel] = sha(sourceText);
    }
    const body = sourceText == null ? null : dropHeadings(sourceText, config.excludeHeadings);
    const userText = removeRegion(read(path.join(root, rel)) ?? "", "md", "", "end");
    const block = (pointer) => (dir === "" ? rootBlock(body, restrictions.needsHuman, pointer) : nestedBlock(body, pointer));
    const size = (pointer) => Buffer.byteLength(setRegion(userText, "md", "", block(pointer), "end"));
    return { dir, rel, sourceRel, hasSource: sourceText != null, block, size, pointer: size(false) > budget };
  });
  const total = () => files.reduce((sum, file) => sum + file.size(file.pointer), 0);
  while (total() > budget) {
    const largest = files.filter((file) => !file.pointer).sort((a, b) => b.size(false) - a.size(false))[0];
    if (!largest) {
      break;
    }
    largest.pointer = true;
  }
  let maxBytes = total() > DEFAULT_BUDGET ? Math.min(MAX_BUDGET, Math.ceil(total() / 4096) * 4096) : null;
  for (const file of files) {
    if (file.hasSource) {
      rules.push(
        file.pointer
          ? { rule: file.sourceRel, outcome: "instruction-only", how: "too large to copy within Codex's instruction budget; AGENTS.md tells Codex to read it" }
          : { rule: file.sourceRel, outcome: "enforced", how: `copied verbatim into ${file.rel}` }
      );
    }
  }
  for (const personal of [".claude/settings.local.json", "CLAUDE.local.md"]) {
    if (fs.existsSync(path.join(root, personal))) {
      rules.push({ rule: personal, outcome: "not mirrored", how: "personal or external file" });
    }
  }

  // Codex config.
  const protectedPaths = [...SELF_PROTECTED, ...files.filter((file) => file.dir).map((file) => file.rel)];
  rules.push({ rule: "always added by duet-workbench", outcome: "enforced", how: `${SELF_PROTECTED.join(", ")} are read-only for delegated runs` });
  const keys = [];
  if (userKeys.has("default_permissions")) {
    notes.push(`${TOML_REL} sets default_permissions = ${userKeys.get("default_permissions")} itself; kept. Delegated runs still use the duet profiles.`);
  } else {
    keys.push('default_permissions = "duet-read"');
  }
  if (maxBytes != null) {
    if (userKeys.has("project_doc_max_bytes")) {
      if (Number(userKeys.get("project_doc_max_bytes")) < maxBytes) {
        notes.push(`${TOML_REL} sets project_doc_max_bytes = ${userKeys.get("project_doc_max_bytes")}, but the mirrored instructions need ${maxBytes}; raise it or Codex will cut the rules short.`);
      }
      maxBytes = null;
    } else {
      keys.push(`project_doc_max_bytes = ${maxBytes}`);
    }
  }
  const profiles = [
    renderProfile("duet-read", ":read-only", "duet-workbench: read-only delegated runs, with this project's Claude restrictions", restrictions, false, protectedPaths, checkoutRoot),
    renderProfile("duet", ":workspace", "duet-workbench: write-enabled delegated runs, with this project's Claude restrictions", restrictions, true, protectedPaths, checkoutRoot)
  ].join("\n\n");

  const hookRegistered = restrictions.deny.length > 0 || restrictions.hooks.length > 0;
  const targets = [
    ...files.map((file) => regionTarget(file.rel, "md", [{ id: "", position: "end", body: file.block(file.pointer) }])),
    regionTarget(TOML_REL, "toml", [
      { id: "keys", position: "top", body: keys.length ? keys.join("\n") : null },
      { id: "profiles", position: "end", body: profiles }
    ]),
    fileTarget(GUARD_REL, `${JSON.stringify({ version: 1, deny: restrictions.deny, hooks: restrictions.hooks }, null, 2)}\n`),
    fileTarget(ADAPTER_REL, fs.readFileSync(ADAPTER_SOURCE, "utf8"))
  ];
  const hooksText = read(path.join(root, HOOKS_REL));
  let hooksValid = true;
  try {
    JSON.parse(hooksText || "{}");
  } catch (error) {
    hooksValid = false;
    conflicts.push(`${HOOKS_REL} is not valid JSON (${error.message}); fix it, then sync again.`);
  }
  if (hooksValid && (hookRegistered || hooksText != null)) {
    targets.push(hooksTarget(root, hookRegistered));
  }

  return { root, config, targets, rules, conflicts, notes, sources, hookRegistered, hookCommand: hookRegistered ? hookCommand(root) : null };
}

// ---------- check, apply, remove ----------

function diffTargets(root, plan, ledger) {
  const differences = [];
  for (const target of plan.targets) {
    const current = read(path.join(root, target.rel));
    const managed = current == null ? null : target.managed(current);
    if (managed === target.desired) {
      continue;
    }
    const recorded = ledger?.targets?.[target.rel]?.hash;
    const kind = managed == null ? "missing" : recorded && sha(managed) !== recorded ? "edited" : "stale";
    differences.push({ target: target.rel, kind, current });
  }
  const planned = new Set(plan.targets.map((target) => target.rel));
  for (const rel of Object.keys(ledger?.targets ?? {})) {
    if (!planned.has(rel) && fs.existsSync(path.join(root, rel))) {
      differences.push({ target: rel, kind: "orphan", current: read(path.join(root, rel)) });
    }
  }
  return differences;
}

const DIFFERENCE_TEXT = {
  missing: "is missing or lost its managed part",
  stale: "is out of date with the Claude-side rules",
  edited: "was edited by hand inside the managed part",
  orphan: "is no longer needed (its CLAUDE.md is gone)"
};

export function checkSync(root) {
  if (!isInitialised(root)) {
    return { state: "not-initialised", differences: [], changedSources: [], conflicts: [], notes: [], rules: [], hookRegistered: false, hookCommand: null, mode: null };
  }
  const plan = buildPlan(root);
  const ledger = readLedger(root);
  const differences = diffTargets(root, plan, ledger).map(({ target, kind }) => ({ target, kind, message: `${target} ${DIFFERENCE_TEXT[kind]}` }));
  const names = new Set([...Object.keys(plan.sources), ...Object.keys(ledger.sources ?? {})]);
  const changedSources = [...names].filter((name) => plan.sources[name] !== ledger.sources?.[name]).sort();
  return {
    state: plan.conflicts.length ? "conflict" : differences.length ? "differences" : "in-sync",
    differences,
    changedSources,
    conflicts: plan.conflicts,
    notes: plan.notes,
    rules: plan.rules,
    hookRegistered: plan.hookRegistered,
    hookCommand: plan.hookCommand,
    mode: plan.config.auto
  };
}

function stripTarget(rel, current, entry) {
  if (path.basename(rel) === "AGENTS.md") {
    return removeRegion(current, "md", "", "end");
  }
  if (rel === TOML_REL) {
    return removeRegion(removeRegion(current, "toml", "profiles", "end"), "toml", "keys", "top");
  }
  if (rel === HOOKS_REL) {
    if (entry?.original != null && sha(current) === entry.writtenHash) {
      return entry.original;
    }
    const data = JSON.parse(current || "{}");
    return stringifyHooks(data, (data.hooks?.PreToolUse ?? []).filter((item) => !isAdapterEntry(item)));
  }
  return "";
}

function retire(root, rel, entry, dryRun) {
  const file = path.join(root, rel);
  const current = read(file);
  if (current == null) {
    return null;
  }
  const next = stripTarget(rel, current, entry);
  if (next === "" && entry?.created) {
    if (!dryRun) {
      fs.rmSync(file);
    }
    return { target: rel, action: "delete" };
  }
  if (next === current) {
    return null;
  }
  if (!dryRun) {
    writeAtomic(file, next);
  }
  return { target: rel, action: "restore" };
}

export function applySync(root, { init = false, overwriteEdited = false, dryRun = false } = {}) {
  const initialised = isInitialised(root);
  if (!initialised && !init) {
    throw new Error("This project is not set up for duet-workbench. Run /duet:init first.");
  }
  const plan = buildPlan(root);
  if (plan.conflicts.length) {
    return { applied: false, changes: [], skipped: [], conflicts: plan.conflicts, notes: plan.notes };
  }
  const ledger = readLedger(root) ?? { version: 1, sources: {}, targets: {}, createdDirs: [] };
  const before = JSON.stringify(ledger);
  const changes = [];
  const skipped = [];
  const byRel = new Map(plan.targets.map((target) => [target.rel, target]));

  if (!initialised && !dryRun && !fs.existsSync(path.join(root, CONFIG_REL))) {
    writeAtomic(path.join(root, CONFIG_REL), `${JSON.stringify(DEFAULT_PROJECT_CONFIG, null, 2)}\n`);
  }
  if (!initialised) {
    changes.push({ target: CONFIG_REL, action: "create" });
  }

  for (const { target: rel, kind, current } of diffTargets(root, plan, ledger)) {
    if (kind === "orphan") {
      const change = retire(root, rel, ledger.targets[rel], dryRun);
      if (change) {
        changes.push(change);
      }
      delete ledger.targets[rel];
      continue;
    }
    if (kind === "edited" && !overwriteEdited) {
      skipped.push({ target: rel, message: `${rel} ${DIFFERENCE_TEXT.edited}; sync again with --overwrite-edited to replace it with the generated version.` });
      continue;
    }
    const target = byRel.get(rel);
    const entry = ledger.targets[rel] ?? { created: current == null };
    const next = target.apply(current);
    if (rel === HOOKS_REL) {
      if (!("original" in entry)) {
        entry.original = current;
      }
      entry.writtenHash = sha(next);
    }
    if (rel.startsWith(".codex/") && !fs.existsSync(path.join(root, ".codex")) && !ledger.createdDirs.includes(".codex")) {
      ledger.createdDirs.push(".codex");
    }
    if (next === "" && entry.created) {
      if (!dryRun && current != null) {
        fs.rmSync(path.join(root, rel));
      }
      delete ledger.targets[rel];
      changes.push({ target: rel, action: "delete" });
      continue;
    }
    if (!dryRun) {
      writeAtomic(path.join(root, rel), next);
    }
    ledger.targets[rel] = entry;
    changes.push({ target: rel, action: current == null ? "create" : "update" });
  }

  for (const target of plan.targets) {
    if (ledger.targets[target.rel]) {
      const skippedHere = skipped.some((item) => item.target === target.rel);
      if (!skippedHere) {
        ledger.targets[target.rel].hash = target.desired == null ? null : sha(target.desired);
      }
    } else if (target.desired != null && read(path.join(root, target.rel)) != null && !dryRun) {
      // Already matching (for example after a re-init): adopt it without claiming we created it.
      ledger.targets[target.rel] = { created: false, hash: sha(target.desired) };
    }
  }
  ledger.sources = plan.sources;
  if (!dryRun && (JSON.stringify(ledger) !== before || !initialised)) {
    writeAtomic(path.join(root, LEDGER_REL), `${JSON.stringify(ledger, null, 2)}\n`);
  }
  return { applied: !dryRun, changes, skipped, conflicts: [], notes: plan.notes };
}

// Files a worktree of this project needs so Codex applies the same rules there (V9: config is read
// from the worktree, hooks and trust from the main checkout).
export function mirrorPaths(root) {
  const ledger = readLedger(root);
  if (!ledger) {
    return [];
  }
  return [...new Set([STATE_DIR, ...Object.keys(ledger.targets)])].filter((rel) => fs.existsSync(path.join(root, rel)));
}

// The project's .codex/config.toml as it must read inside a worktree: same profiles plus the
// main checkout's workspace denies as absolute paths.
export function checkoutConfigToml(root, currentText) {
  const target = buildPlan(root, { checkoutRoot: root }).targets.find((item) => item.rel === TOML_REL);
  return target ? target.apply(currentText) : currentText;
}

export function removeMirror(root, { dryRun = false } = {}) {
  const ledger = readLedger(root);
  if (!ledger) {
    throw new Error("This project is not set up for duet-workbench; there is nothing to remove.");
  }
  const actions = [];
  for (const [rel, entry] of Object.entries(ledger.targets)) {
    if (rel.startsWith(`${STATE_DIR}/`)) {
      continue;
    }
    const change = retire(root, rel, entry, dryRun);
    if (change) {
      actions.push(change);
    }
  }
  for (const dir of ledger.createdDirs ?? []) {
    const full = path.join(root, dir);
    const empty = fs.existsSync(full) && fs.readdirSync(full).every((name) => actions.some((a) => a.action === "delete" && a.target === `${dir}/${name}`));
    if (empty) {
      if (!dryRun) {
        fs.rmSync(full, { recursive: true });
      }
      actions.push({ target: `${dir}/`, action: "delete" });
    }
  }
  if (!dryRun) {
    fs.rmSync(path.join(root, STATE_DIR), { recursive: true, force: true });
  }
  actions.push({ target: `${STATE_DIR}/`, action: "delete" });
  return { removed: !dryRun, actions };
}

// What the human still has to do in Codex. `guard` comes from the Codex app server
// (config/read and hooks/list); null means it could not be asked.
export function trustProblems(root, status, guard) {
  if (!guard) {
    return [];
  }
  const problems = [];
  if (!guard.projectTrusted) {
    problems.push(`Codex does not trust this project yet, so its restrictions would not apply. In a terminal: cd ${root} && codex — then choose to trust the folder.`);
  } else if (status.hookRegistered) {
    const hook = guard.hooks.find((item) => item.command === status.hookCommand);
    if (hook?.trustStatus !== "trusted" && hook?.trustStatus !== "managed") {
      problems.push(`The duet-workbench guard hook is ${hook ? hook.trustStatus : "not loaded"} in Codex, so it would be skipped silently. In a terminal: cd ${root} && codex — type /hooks, open PreToolUse, select the hook and press t to trust it.`);
    }
  }
  return problems;
}
