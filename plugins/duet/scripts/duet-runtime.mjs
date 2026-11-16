#!/usr/bin/env node
// Modified from openai/codex-plugin-cc@db52e28 (Apache-2.0) by Duet Workbench; see NOTICE.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readProjectGuardState,
    readRateLimits,
    readThreadHistory,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  setConfig,
  updateState,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { applyJobWorktree, canUseWorktree, createJobWorktree, finishJobWorktree, removeJobWorktree, uncommittedFiles } from "./lib/worktree.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

import { applySync, buildPlan, checkSync, isInitialised, removeMirror, trustProblems } from "./sync/engine.mjs";
import { renderDoctor, renderRemove, renderSyncApply, renderSyncStatus } from "./sync/report.mjs";
import { inferType, shapePrompt, wantsWrite } from "./lib/shape.mjs";
import { describeValidChoices, loadModelCatalog, renderModelCatalog, resolveModelAlias } from "./lib/models.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/duet-runtime.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/duet-runtime.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--json]",
      "  node scripts/duet-runtime.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--json] [focus text]",
      "  node scripts/duet-runtime.mjs task [--background] [--write [--here]] [--resume-last|--resume|--fresh] [--model <model|sol|astra|terra|luna>] [--effort <effort>] [--title <text>] [--json] [prompt]",
      "  node scripts/duet-runtime.mjs shape [--type <auto|implement|diagnose|review|research|audit>] [--write|--access <auto|read|write>] [--json] [task]",
      "  node scripts/duet-runtime.mjs models [--json]",
      "  node scripts/duet-runtime.mjs limits [--json]",
      "  node scripts/duet-runtime.mjs history [job-id] [--json]",
      "  node scripts/duet-runtime.mjs forget <job-id> [--json]",
      "  node scripts/duet-runtime.mjs status --project [--json]",
      "  node scripts/duet-runtime.mjs sync-check [--json]",
      "  node scripts/duet-runtime.mjs sync-apply [--init] [--overwrite-edited] [--dry-run] [--json]",
      "  node scripts/duet-runtime.mjs doctor [--json]",
      "  node scripts/duet-runtime.mjs remove [--dry-run] [--json]",
      "  node scripts/duet-runtime.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/duet-runtime.mjs status [job-id] [--all] [--json]",
      "  node scripts/duet-runtime.mjs result [job-id] [--json]",
      "  node scripts/duet-runtime.mjs cancel [job-id] [--json]",
      "  node scripts/duet-runtime.mjs apply [job-id] [--json]",
      "  node scripts/duet-runtime.mjs discard [job-id] [--json]",
      "  node scripts/duet-runtime.mjs init-offer [--decline <session|never>] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return resolveModelAlias(normalized);
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  // No whitelist: Codex is the judge of effort values (PLAN D3).
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/duet:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/duet:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/duet:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/duet:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/duet:review` target is not supported by the built-in reviewer. Retry with `/duet:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /duet:jobs before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    title: request.title
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(request.worktree?.path ?? request.viewPath ?? workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    write: Boolean(request.write),
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  let failureMessage = result.error?.message ?? result.stderr ?? "";
  if (result.status !== 0 && (request.model || request.effort)) {
    failureMessage = [failureMessage, describeValidChoices(request.model)].filter(Boolean).join(" ");
  }
  let worktree = null;
  if (request.worktree) {
    worktree = finishJobWorktree(request.worktree, taskMetadata.title);
    if (worktree.state === "empty") {
      removeJobWorktree(workspaceRoot, worktree);
    }
    upsertJob(workspaceRoot, { id: request.jobId, worktree });
  }
  const rendered =
    renderTaskResult(
      {
        rawOutput,
        failureMessage,
        reasoningSummary: result.reasoningSummary
      },
      {
        title: taskMetadata.title,
        jobId: request.jobId ?? null,
        write: Boolean(request.write)
      }
    ) + renderWorktreeNote(worktree, request.jobId);
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    worktree
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function renderWorktreeNote(worktree, jobId) {
  if (!worktree) {
    return "";
  }
  if (worktree.state === "empty") {
    return "\n[duet] No files changed.\n";
  }
  const shown = worktree.files.slice(0, 10).map((file) => `  ${file}`);
  if (worktree.files.length > shown.length) {
    shown.push(`  … and ${worktree.files.length - shown.length} more`);
  }
  return `\n[duet] Codex's changes are on branch ${worktree.branch}, not yet in your files (${worktree.files.length} file${worktree.files.length === 1 ? "" : "s"}):\n${shown.join("\n")}\nApply or discard them: /duet:result ${jobId}\n`;
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false, title: given = null }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  // The run is listed by what was asked: the Goal line of a shaped prompt, or the prompt's start.
  const goal = (/^Goal: ([\s\S]*?)(?:\n\n|$)/.exec(String(prompt ?? ""))?.[1] ?? String(prompt ?? "")).trim();
  // --title: a name the caller already made for the run (the panel asks a small model for one).
  const named = String(given ?? "").replace(/\s+/g, " ").trim();
  const title = named ? shorten(named, 60) : goal ? shorten(goal, 60) : resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /duet:jobs ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, worktree = null, viewPath = null, title = null }) {
  return {
    title,
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    worktree,
    viewPath
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "duet-runtime.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  await prepareDelegation(workspaceRoot);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "title"],
    booleanOptions: ["json", "write", "here", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  await prepareDelegation(workspaceRoot);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
    title: options.title
  });
  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);
  }
  // model/effort are kept on the job so the jobs list can show them (null = Codex default).
  const job = { ...buildTaskJob(workspaceRoot, taskMetadata, write), model: model ?? null, effort: effort ?? null };
  const worktree = write ? prepareWriteCheckout(workspaceRoot, job, { here: Boolean(options.here), resumeLast }) : null;
  // A read-only follow-up to a write run whose changes are not applied yet looks at that run's copy,
  // or Codex would not find the files it has just changed.
  const viewPath = !write && resumeLast ? pendingResumeJob(workspaceRoot)?.worktree.path ?? null : null;

  if (options.background) {
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      worktree,
      viewPath,
      title: options.title
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        worktree,
        viewPath,
        title: options.title,
        onProgress: progress
      }),
    { json: options.json }
  );
}

// The finished task run whose worktree still holds unapplied changes, if any.
function pendingResumeJob(root) {
  return sortJobsNewestFirst(filterJobsForCurrentClaudeSession(listJobs(root))).find(
    (other) => other.jobClass === "task" && other.worktree?.state === "pending" && !isActiveJobStatus(other.status) && fs.existsSync(other.worktree.path)
  );
}

// F9: a write run gets its own worktree; --here writes in this folder, one such run at a time.
// A resumed write run continues in the previous run's worktree while its changes are unapplied.
function prepareWriteCheckout(root, job, { here, resumeLast }) {
  if (here || !canUseWorktree(root)) {
    if (!here) {
      process.stderr.write("duet-workbench: this folder has no git commit yet, so Codex writes here directly.\n");
    }
    const busy = listJobs(root).find((other) => other.id !== job.id && other.write && !other.worktree && isActiveJobStatus(other.status));
    if (busy) {
      throw new Error(`Another write run (${busy.id}) is working in this folder. Wait for it to finish, or delegate without --here so Codex works in its own copy.`);
    }
    return null;
  }
  let worktree = null;
  if (resumeLast) {
    const previous = pendingResumeJob(root);
    if (previous) {
      worktree = previous.worktree;
      upsertJob(root, { id: previous.id, worktree: { ...previous.worktree, state: "moved", movedTo: job.id } });
    }
  }
  worktree ??= createJobWorktree(root, job.id);
  job.worktree = worktree;
  const pending = uncommittedFiles(root);
  if (pending.length) {
    process.stderr.write(`duet-workbench: Codex works on your last commit in its own copy; your ${pending.length} uncommitted change${pending.length === 1 ? " is" : "s are"} not included.\n`);
  }
  return worktree;
}

function resolveWorktreeJob(options, reference) {
  const root = resolveCommandWorkspace(options);
  const jobs = sortJobsNewestFirst(listJobs(root)).filter((job) => job.worktree?.state === "pending");
  const job = reference ? jobs.find((item) => item.id === reference || item.id.startsWith(reference)) : jobs[0];
  if (!job) {
    throw new Error(reference ? `There are no unapplied Codex changes for ${reference}.` : "There are no unapplied Codex changes in this repository.");
  }
  if (isActiveJobStatus(job.status)) {
    throw new Error(`${job.id} is still running; wait for it to finish.`);
  }
  return { root, job };
}

function handleApply(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const { root, job } = resolveWorktreeJob(options, positionals[0]);
  const files = applyJobWorktree(root, job.worktree);
  upsertJob(root, { id: job.id, worktree: { ...job.worktree, state: "applied" } });
  const payload = { jobId: job.id, branch: job.worktree.branch, applied: files };
  outputCommandResult(payload, `Applied ${files.length} file${files.length === 1 ? "" : "s"} from ${job.worktree.branch} to your working tree (staged, not committed):\n${files.map((file) => `  ${file}`).join("\n")}\n`, options.json);
}

function handleDiscard(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const { root, job } = resolveWorktreeJob(options, positionals[0]);
  removeJobWorktree(root, job.worktree);
  upsertJob(root, { id: job.id, worktree: { ...job.worktree, state: "discarded" } });
  outputCommandResult({ jobId: job.id, discarded: job.worktree.branch }, `Discarded Codex's changes on ${job.worktree.branch}.\n`, options.json);
}

// Take a finished run out of the list: its record, its log, and its worktree if changes were left unapplied.
function handleForget(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const root = resolveCommandWorkspace(options);
  const job = listJobs(root).find((other) => other.id === positionals[0]);
  if (!job) {
    throw new Error(`No Codex run "${positionals[0] ?? ""}" in this project.`);
  }
  if (isActiveJobStatus(job.status)) {
    throw new Error(`Run ${job.id} is still ${job.status}. Cancel it first.`);
  }
  if (job.worktree?.state === "pending") {
    removeJobWorktree(root, job.worktree);
  }
  updateState(root, (state) => {
    state.jobs = state.jobs.filter((other) => other.id !== job.id);
  });
  fs.rmSync(resolveJobFile(root, job.id), { force: true });
  fs.rmSync(resolveJobLogFile(root, job.id), { force: true });
  outputCommandResult({ jobId: job.id, forgotten: true }, `Removed ${job.id} from the list. The Codex thread itself is kept by Codex.\n`, options.json);
}

// F5 init offer: a project with Claude security rules that is not set up for Codex yet.
const NOT_NOW_HOURS = 8;

function handleInitOffer(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "decline"], booleanOptions: ["json"] });
  const root = resolveCommandWorkspace(options);
  const file = path.join(resolveStateDir(root), "init-offer.json");
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    saved = {};
  }
  const sessionId = getCurrentClaudeSessionId();
  if (options.decline) {
    if (!["session", "never"].includes(options.decline)) {
      throw new Error("--decline takes session or never.");
    }
    const next = options.decline === "never" ? { ...saved, never: true } : { ...saved, notNow: { sessionId, at: nowIso() } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    outputCommandResult({ declined: options.decline }, options.decline === "never" ? "duet-workbench will not offer setup in this project again (/duet:init still works).\n" : "duet-workbench will ask again next session.\n", options.json);
    return;
  }
  const notNow = saved.notNow
    ? sessionId
      ? saved.notNow.sessionId === sessionId
      : Date.now() - Date.parse(saved.notNow.at) < NOT_NOW_HOURS * 3600 * 1000
    : false;
  const rules =
    isInitialised(root) || saved.never || notNow
      ? []
      : buildPlan(root).rules.filter((rule) => rule.outcome === "enforced" && /^(permissions|hooks)\./.test(rule.rule)).map((rule) => rule.rule);
  const payload = { offer: rules.length > 0, rules };
  outputCommandResult(
    payload,
    payload.offer ? `This project has security rules (${rules.length}) that Codex does not apply yet. Set them up: /duet:init\n` : "No setup offer for this project.\n",
    options.json
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

const MIN_CODEX_VERSION = [0, 159, 0];

// D7 and the Phase 0 findings: Codex must have the project's current rules, and must actually
// apply them. An untrusted project or hook is skipped silently by Codex, so stop here instead.
async function prepareDelegation(root) {
  if (!isInitialised(root)) {
    return;
  }
  let status = checkSync(root);
  if (status.state === "differences" && status.mode === "auto") {
    const result = applySync(root);
    if (result.changes.length) {
      process.stderr.write(`duet-workbench: synced this project's rules for Codex (${result.changes.map((change) => change.target).join(", ")}).\n`);
    }
    status = checkSync(root);
  }
  if (status.state === "conflict") {
    throw new Error(`duet-workbench cannot mirror this project's rules for Codex: ${status.conflicts.join(" ")}`);
  }
  if (status.state !== "in-sync") {
    throw new Error(`Codex's copy of this project's rules is out of date: ${status.differences.map((item) => item.message).join("; ")}. Run /duet:sync, then delegate again.`);
  }
  const problems = trustProblems(root, status, await readProjectGuardState(root));
  if (problems.length) {
    throw new Error(problems.join("\n"));
  }
}

function trustNextSteps(root, status) {
  const steps = [`In a terminal: cd ${root} && codex — choose to trust the folder (once).`];
  if (status.hookRegistered) {
    steps.push("Then in that Codex session type /hooks, open PreToolUse, select the duet-workbench hook and press t to trust it (once).");
  }
  return steps;
}

async function handleSyncCheck(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const status = checkSync(resolveCommandWorkspace(options));
  outputCommandResult(status, renderSyncStatus(status), options.json);
}

async function handleSyncApply(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "init", "overwrite-edited", "dry-run"]
  });
  const root = resolveCommandWorkspace(options);
  const firstTime = !isInitialised(root);
  const result = applySync(root, {
    init: Boolean(options.init),
    overwriteEdited: Boolean(options["overwrite-edited"]),
    dryRun: Boolean(options["dry-run"])
  });
  if (firstTime && result.conflicts.length === 0) {
    result.nextSteps = trustNextSteps(root, result.applied ? checkSync(root) : buildPlan(root));
  }
  outputCommandResult(result, renderSyncApply(result), options.json);
}

async function handleRemove(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "dry-run"] });
  const result = removeMirror(resolveCommandWorkspace(options), { dryRun: Boolean(options["dry-run"]) });
  outputCommandResult(result, renderRemove(result), options.json);
}

async function buildDoctorReport(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  const codex = getCodexAvailability(cwd);
  const version = /(\d+)\.(\d+)\.(\d+)/.exec(codex.detail ?? "")?.slice(1).map(Number) ?? null;
  const firstDifference = version?.findIndex((part, index) => part !== MIN_CODEX_VERSION[index]) ?? -1;
  const tooOld = firstDifference >= 0 && version[firstDifference] < MIN_CODEX_VERSION[firstDifference];
  const auth = await getCodexAuthStatus(cwd);
  const status = checkSync(root);
  const initialised = status.state !== "not-initialised";
  const plan = initialised ? null : buildPlan(root);

  const prerequisites = [
    { name: "Codex CLI", ok: codex.available && !tooOld, detail: codex.detail, fix: codex.available ? `Update Codex to ${MIN_CODEX_VERSION.join(".")} or newer: npm install -g @openai/codex` : "Install Codex: npm install -g @openai/codex" },
    { name: "Signed in to Codex", ok: Boolean(auth.loggedIn), detail: auth.detail, fix: "In a terminal: codex login" }
  ];
  if (initialised && codex.available) {
    let guard = null;
    let failure = null;
    try {
      guard = await readProjectGuardState(root);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const problems = guard ? trustProblems(root, status, guard) : [];
    const projectProblem = guard && !guard.projectTrusted ? problems[0] : null;
    prerequisites.push({ name: "Project trusted in Codex", ok: Boolean(guard?.projectTrusted), detail: "Codex applies this project's config", fix: projectProblem ?? `Could not ask Codex (${failure}).` });
    if (status.hookRegistered) {
      const hookProblem = guard?.projectTrusted ? problems[0] ?? null : "Trust the project first; the hook can only be trusted after that.";
      prerequisites.push({ name: "Guard hook trusted in Codex", ok: Boolean(guard) && hookProblem == null, detail: "Codex runs the duet-workbench guard hook", fix: hookProblem ?? `Could not ask Codex (${failure}).` });
    }
  }

  return {
    project: root,
    ok: prerequisites.every((item) => item.ok) && status.state === "in-sync",
    state: status.state,
    prerequisites,
    drift: { differences: status.differences, changedSources: status.changedSources, conflicts: initialised ? status.conflicts : plan.conflicts },
    coverage: initialised ? status.rules : plan.rules,
    notes: [
      ...(initialised ? status.notes : plan.notes),
      ...listJobs(root)
        .filter((job) => job.worktree?.state === "pending" && !isActiveJobStatus(job.status))
        .map((job) => `Codex's changes from ${job.id} are on ${job.worktree.branch} and not applied or discarded yet: /duet:result ${job.id}`)
    ]
  };
}

async function handleDoctor(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const report = await buildDoctorReport(resolveCommandCwd(options));
  outputCommandResult(report, renderDoctor(report), options.json);
}

// Deterministic preview of the shaped prompt (panel Preview, F3). Starts nothing.
function handleShape(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["type", "cwd", "prompt-file", "access"],
    booleanOptions: ["json", "write"]
  });
  const task = readTaskPrompt(resolveCommandCwd(options), options, positionals);
  const type = options.type === "auto" ? inferType(task) : options.type || "implement";
  // --access auto: only a task that asks for a change gets write access (in its own worktree).
  const write = options.access === "auto" ? wantsWrite(task, options.type || "implement") : options.access === "write" || Boolean(options.write);
  const prompt = shapePrompt({ type: options.type || "implement", task, write });
  outputCommandResult({ type, write, prompt }, prompt, options.json);
}

async function handleModels(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const catalog = await loadModelCatalog(resolveCommandCwd(options));
  outputCommandResult(catalog, renderModelCatalog(catalog), options.json);
}

// The whole conversation of a run's Codex thread, as markdown.
async function handleHistory(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const { job } = resolveResultJob(cwd, positionals[0] ?? "");
  if (!job.threadId) {
    throw new Error(`Run ${job.id} has no Codex thread to show.`);
  }
  const turns = await readThreadHistory(cwd, job.threadId);
  const lines = [`# Codex thread ${job.threadId}`, ""];
  turns.forEach((turn, index) => {
    lines.push(`## Message ${index + 1} of ${turns.length}`, "", "**You:**", "", /^Goal: ([\s\S]*?)\n\nContext: /.exec(turn.user)?.[1] ?? (turn.user || "(no text)"), "", "**Codex:**", "", turn.codex || `(no answer; turn ${turn.status ?? "unknown"})`, "");
  });
  outputCommandResult({ threadId: job.threadId, turns }, lines.join("\n"), options.json);
}

// What is left of the Codex quota: a bar and a percent per window.
async function handleLimits(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const limits = await readRateLimits(resolveCommandCwd(options));
  const lines = limits.map((limit) => {
    const filled = Math.round(limit.leftPercent / 5);
    const resets = limit.resetsAt ? `, resets ${limit.resetsAt.slice(0, 16).replace("T", " ")} UTC` : "";
    return `${limit.label.padEnd(8)}${"█".repeat(filled)}${"░".repeat(20 - filled)} ${limit.leftPercent}% left${resets}`;
  });
  outputCommandResult({ limits }, `${lines.join("\n") || "Codex reported no limits for this account."}\n`, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait", "project"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all || options.project, project: options.project });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  let rendered = renderStoredJobResult(job, storedJob);
  if (job.worktree && job.worktree.state !== "pending") {
    // The stored text was written before apply/discard; say what happened since.
    rendered = rendered.replace(/\n\[duet\] Codex's changes are on branch[\s\S]*$/, `\n[duet] Codex's changes on ${job.worktree.branch} ${job.worktree.state === "moved" ? `moved on to ${job.worktree.movedTo}` : `were ${job.worktree.state}`}.\n`);
  }
  outputCommandResult(payload, rendered, options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "shape":
      handleShape(argv);
      break;
    case "models":
      await handleModels(argv);
      break;
    case "limits":
      await handleLimits(argv);
      break;
    case "history":
      await handleHistory(argv);
      break;
    case "forget":
      handleForget(argv);
      break;
    case "sync-check":
      await handleSyncCheck(argv);
      break;
    case "sync-apply":
      await handleSyncApply(argv);
      break;
    case "doctor":
      await handleDoctor(argv);
      break;
    case "remove":
      await handleRemove(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "apply":
      handleApply(argv);
      break;
    case "discard":
      handleDiscard(argv);
      break;
    case "init-offer":
      handleInitOffer(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ error: message }, null, 2));
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
