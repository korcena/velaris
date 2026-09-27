/**
 * Workspace resolution — the single effective-allowlist rule (workspace
 * resolution design, 2026-09-27).
 *
 * The trust anchor for a house with an EMPTY `workspaceAllowlist` is the
 * user-curated project registry (`projects.directory`); a non-empty allowlist
 * remains fully restrictive and the registry is not consulted. Every execution
 * gate (engine queue, high-lord orchestrator, Ollama tool guard, worktree path)
 * calls `effectiveWorkspaceAllowlist` so no two gates can disagree — the bug
 * this replaced was the orchestrator treating an empty allowlist as usable while
 * the queue rejected it unconditionally.
 *
 * This lives in the repository layer (not `src/lib/paths.ts`) because it needs
 * `VelarisDb` + `listProjects`/`getProject` and must be importable by both the
 * web and engine processes; `paths.ts` stays a pure, DB-free utility.
 */

import type { VelarisDb } from "@/lib/db";
import { listProjects, getProject } from "./project-repo";
import type { HouseConfiguration, TaskDto } from "@/shared/types";

/** Actionable failure when a house has no allowlist and no registered project
 * can anchor the run. Shown in `tasks.last_error` / `task_failed` events and in
 * the orchestrator's `no_destination` abort notification body. */
export const WORKSPACE_UNREGISTERED_MESSAGE =
  "Register this directory as a project, or set a workspace allowlist on the house.";

/**
 * The list every execution gate must validate against:
 *  - non-empty house allowlist → that list verbatim (fully restrictive);
 *  - empty house allowlist     → every registered project directory.
 *
 * Computed fresh from the DB each call (no cache) so it can never drift from the
 * registry. Zero projects + empty allowlist → `[]` (nothing runs).
 */
export function effectiveWorkspaceAllowlist(
  db: VelarisDb,
  configuration: HouseConfiguration,
): string[] {
  return configuration.workspaceAllowlist.length > 0
    ? configuration.workspaceAllowlist
    : listProjects(db).map((p) => p.directory);
}

/**
 * The task's project directory, or null when the task has no project / the
 * project was deleted. Used as the `D` fallback when a task carries no
 * `workingDirectory` and the house allowlist is empty.
 */
export function projectDirectoryForTask(db: VelarisDb, task: TaskDto): string | null {
  return task.projectId ? (getProject(db, task.projectId)?.directory ?? null) : null;
}
