// Plain-text renderings of the mirror commands (the UI and --json callers use the raw objects).

const STATE_TEXT = {
  "in-sync": "In sync: Codex has this project's current rules.",
  differences: "Differences found between the Claude-side rules and Codex's copy.",
  conflict: "Conflict: the mirror cannot be written until this is fixed.",
  "not-initialised": "Not set up: this project has no duet-workbench mirror. Run /duet:init to create it."
};

const list = (items) => items.map((item) => `- ${item}`);

export function renderSyncStatus(status) {
  return `${[
    STATE_TEXT[status.state],
    ...list(status.conflicts),
    ...list(status.differences.map((item) => item.message)),
    ...(status.changedSources.length ? [`Changed since the last sync: ${status.changedSources.join(", ")}`] : []),
    ...list(status.notes)
  ].join("\n")}\n`;
}

export function renderSyncApply(result) {
  if (result.conflicts.length) {
    return `Nothing was written.\n${list(result.conflicts).join("\n")}\n`;
  }
  const verb = result.applied ? "" : "would ";
  const lines = result.changes.length
    ? result.changes.map((change) => `- ${verb}${change.action} ${change.target}`)
    : ["Nothing to change; Codex's copy is up to date."];
  return `${[...lines, ...list(result.skipped.map((item) => item.message)), ...list(result.notes), ...list(result.nextSteps ?? [])].join("\n")}\n`;
}

export function renderRemove(result) {
  const verb = result.removed ? "" : "would ";
  return `${result.actions.map((action) => `- ${verb}${action.action} ${action.target}`).join("\n")}\n`;
}

export function renderDoctor(report) {
  const lines = ["Prerequisites"];
  for (const item of report.prerequisites) {
    lines.push(`- ${item.ok ? "ok" : "FIX"}: ${item.name} — ${item.ok ? item.detail : item.fix}`);
  }
  lines.push("", "Drift", STATE_TEXT[report.state], ...list(report.drift.conflicts), ...list(report.drift.differences.map((item) => item.message)));
  if (report.drift.changedSources.length) {
    lines.push(`Changed since the last sync: ${report.drift.changedSources.join(", ")}`);
  }
  lines.push("", `Coverage${report.state === "not-initialised" ? " (what init would mirror)" : ""}`);
  for (const rule of report.coverage) {
    lines.push(`- ${rule.outcome}: ${rule.rule} — ${rule.how}`);
  }
  lines.push(...list(report.notes));
  return `${lines.join("\n")}\n`;
}
