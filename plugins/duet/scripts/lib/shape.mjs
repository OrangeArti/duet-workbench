// Deterministic prompt shaping for the panel's Preview: one recipe per task type,
// following skills/gpt-6-prompting/references/prompt-recipes.md. No model involved; the
// human edits the preview. The codex-worker subagent still shapes with the full skill.

const AUTONOMY =
  "Work without asking me questions. If something is unclear, take the most reasonable low-risk reading and say which reading you took. Stop and report instead of acting if a step would be destructive or irreversible.";

const RECIPES = {
  implement: {
    label: "Implement",
    context: "Follow the patterns already used in this repository. Start from the files the task names.",
    constraints: "Smallest change that does the job. No unrelated refactors, renames or dependency changes.",
    done: "The behaviour described in the goal works and the existing tests still pass.",
    verification: "Run the narrowest test command that covers the change once; rerun only if you change code again. Do not run the full suite.",
    report: "what changed and why, touched files, checks run with their result, remaining risks."
  },
  diagnose: {
    label: "Diagnose",
    context: "The failure is described in the goal. Relevant code is probably near the files or commands it names.",
    constraints: "I need the root cause, not a fix yet.",
    done: "You can name the root cause and point to the lines and the evidence that support it.",
    verification: "Reproduce the failure once if a command is given; do not run the full suite.",
    report: "1) root cause, 2) evidence (files, lines, command output), 3) smallest safe next step, 4) what you could not confirm. Mark hypotheses as hypotheses."
  },
  review: {
    label: "Review",
    context: "Review the local changes of this repository (working tree and branch against its base) unless the goal names something else.",
    constraints: "Report findings only; do not fix them. Only issues that change behaviour, safety or correctness; no style notes.",
    done: "Every changed file was read and each finding has a file, a line and a concrete failure scenario.",
    verification: "Read the code; run a test only to confirm a suspected bug.",
    report: "findings ordered by severity, each with file:line, what breaks and a suggested fix; then what you did not review."
  },
  research: {
    label: "Research",
    context: "Use this repository as the primary source; say when a claim comes from outside it.",
    constraints: "Give a recommendation, not a survey. Separate what you verified from what you assume.",
    done: "The question in the goal has a direct answer with the evidence that supports it.",
    verification: "Check each claim against the code or documentation you cite.",
    report: "the answer first, then the evidence, the alternatives you rejected and why, and open questions."
  },
  audit: {
    label: "Parallel audit",
    context: "Split the repository into independent areas and audit them in parallel where you can.",
    constraints: "Report findings only. Do not repeat the same finding per file; group it.",
    done: "Every area was covered or is listed as not covered, with the reason.",
    verification: "Confirm each finding by reading the code it names; do not run the full suite.",
    report: "findings grouped by area and ordered by severity, each with file:line and evidence; then the areas not covered."
  }
};

export const TASK_TYPES = Object.entries(RECIPES).map(([value, recipe]) => ({ value, label: recipe.label }));

// "auto": the type is read off the task's own words (English or Russian); implement when nothing matches.
const HINTS = [
  ["review", /\breview\b|ревью/i],
  ["audit", /\baudit\b|аудит/i],
  ["diagnose", /\bwhy\b|diagnos|root cause|\bdebug|investigat|\bfail(s|ing|ed)?\b|broken|crash|почему|не работает|падает|ошибк|диагност|разберись/i],
  ["research", /\bresearch\b|\bcompare\b|\bexplain\b|how does|what is|which\b.*\?|\?\s*$|исследуй|сравни|объясни|как работает/i]
];

export function inferType(task) {
  return HINTS.find(([, pattern]) => pattern.test(String(task ?? "")))?.[0] ?? "implement";
}

// Auto access: write only when the task's own words ask for a change. Unsure means read-only;
// the person can still pick Write.
const CHANGE = /\b(fix|add|implement|change|refactor|rename|remove|delete|write|create|update|replace|migrate)\b|почин|исправ|добав|реализ|измени|перепиш|удали|созда|обнови|замени|отрефактор|напиши|сделай/i;

export function wantsWrite(task, type = "auto") {
  if (type !== "auto") {
    return type === "implement";
  }
  return CHANGE.test(String(task ?? "")) && ["implement", "diagnose"].includes(inferType(task));
}

export function shapePrompt({ type = "implement", task, write = false }) {
  const recipe = RECIPES[type === "auto" ? inferType(task) : type];
  if (!recipe) {
    throw new Error(`Unknown task type "${type}". Use one of: auto, ${Object.keys(RECIPES).join(", ")}.`);
  }
  const goal = String(task ?? "").trim();
  if (!goal) {
    throw new Error("Write the task first.");
  }
  const access = write
    ? "You may edit files in this working directory."
    : "Read-only. Do not edit files or install packages.";
  return [
    `Goal: ${goal}`,
    `Context: ${recipe.context}`,
    `Constraints: ${access} ${recipe.constraints}`,
    `Done when: ${recipe.done}`,
    AUTONOMY,
    `Verification: ${recipe.verification}`,
    `Report back with: ${recipe.report} Lead with the result; no closing summary.`
  ].join("\n\n") + "\n";
}
