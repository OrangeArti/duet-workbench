// Modified from openai/codex-plugin-cc@db52e28 (Apache-2.0) by Duet Workbench; see NOTICE.
import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
