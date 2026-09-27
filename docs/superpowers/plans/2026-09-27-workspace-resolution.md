# Plan — Workspace resolution: empty allowlist = "bounded by the project registry"

**Date:** 2026-09-27
**Source of truth:** `docs/superpowers/specs/2026-09-27-workspace-resolution-design.md`

## Goal
An empty house `workspaceAllowlist` stops meaning "cannot run" and starts meaning "bounded by
the registered projects". One resolver, `effectiveWorkspaceAllowlist(db, configuration)`, is used
at every execution gate so the orchestrator, queue, and Ollama tool guard cannot disagree. This
fixes the observed High Lord delegation failure (`{"error":"No workspace allowlist configured"}` →
4 retries → `retries_exhausted`).
- Non-empty allowlist → that list, unchanged (fully restrictive; registry not consulted).
- Empty allowlist → `listProjects(db).map(p => p.directory)`.

## Non-goals
- No schema/migration change; no change to `HouseConfiguration` or allowlist editing.
- No global "workspace root"; no new arbitrary-directory path. `POST /api/tasks` trust unchanged.
- Worktree semantics unchanged apart from the base-list swap.
- Do not touch the HL planning path (`queue.ts:197-207` bypasses `resolveWorkspace`).

## Files
| File | Change |
|---|---|
| `src/server/repositories/workspace.ts` (new) | `effectiveWorkspaceAllowlist`, `projectDirectoryForTask`, `WORKSPACE_UNREGISTERED_MESSAGE`. |
| `src/engine/queue.ts` | Compute effective list once per claim; new `resolveWorkspace`; worktree base list. |
| `src/engine/orchestrator.ts` | `destinationHasUsableWorkspace` + `childExecutionDir` use the effective rule; abort text. |
| `src/server/execution/ollama/runtime.ts` | `allowlist` = effective list (line 121). |
| `src/server/execution/ollama/tools/permissions.ts` | Docblock only (pure gate; no code change). |
| `src/lib/paths.ts` | Docblock only (note callers pass the effective list). |
| `tests/unit/orchestrator.test.ts` | `seedWorld` + test 13; new regression/fail-fast tests. |
| `tests/unit/queue-loop.test.ts` | Empty-allowlist run / fail-fast cases. |
| `tests/unit/workspace-resolution.test.ts` (new) | Helper unit tests. |
| `tests/unit/ollama-runtime.test.ts` | Path-inside uses the effective list. |

## Helper (new `src/server/repositories/workspace.ts`)
Chosen over `src/lib/paths.ts`: it needs `VelarisDb` + `listProjects`/`getProject`
(`project-repo.ts:122,131`), so it belongs in the repository layer both processes may import;
`paths.ts` stays a pure, DB-free utility.
```ts
export const WORKSPACE_UNREGISTERED_MESSAGE =
  "Register this directory as a project, or set a workspace allowlist on the house.";
export function effectiveWorkspaceAllowlist(db: VelarisDb, configuration: HouseConfiguration): string[] {
  return configuration.workspaceAllowlist.length > 0
    ? configuration.workspaceAllowlist
    : listProjects(db).map((p) => p.directory);
}
export function projectDirectoryForTask(db: VelarisDb, task: TaskDto): string | null {
  return task.projectId ? (getProject(db, task.projectId)?.directory ?? null) : null;
}
```

## Per-file changes
### `src/engine/queue.ts`
- Import `effectiveWorkspaceAllowlist`, `projectDirectoryForTask`, `WORKSPACE_UNREGISTERED_MESSAGE`.
- In `runClaimedTask`, before line 230: `const effectiveAllowlist = effectiveWorkspaceAllowlist(db, runtimeConfig);`
  and pass it to `resolveWorkspace(db, task, house, runtimeConfig, effectiveAllowlist)`. Reuse at
  lines 261/264: `houseAllowlist: effectiveAllowlist` and
  `resolveSafePath(worktree.directory, [...effectiveAllowlist, worktreeRoot()])`. Shape unchanged.
- Rewrite `resolveWorkspace` (`371-418`). **D = `task.workingDirectory`**, else (empty house
  allowlist only) `projectDirectoryForTask(db, task)`:
  1. `dir` absent + non-empty allowlist → current fallback `allowlist[0]` (`isPathAllowed` /
     `resolveSafePath`); keep the existing "No working directory and no allowlist entry" failure.
  2. `dir` absent + empty allowlist → fail with `WORKSPACE_UNREGISTERED_MESSAGE` (never pick
     `listProjects()[0]`).
  3. `dir` present → `resolveSafePath(dir, effectiveAllowlist)`; on throw, if the house allowlist
     is empty use `WORKSPACE_UNREGISTERED_MESSAGE`, else keep
     `working_directory outside house allowlist: …` (byte-identical for non-empty).
  Set `setTaskStatus(..., "failed", msg)` + `createExecutionEvent({ type: "task_failed",
  payload: { error: msg } })`. Update the docblock (drop "mirrors the queue").
  *Rationale for gating D's project fallback to empty allowlists:* the spec's compatibility
  clause ("Non-empty → exactly as today; the registry is not consulted") otherwise breaks for a
  task with `projectId` and no `workingDirectory`.### `src/engine/orchestrator.ts`
- Import `effectiveWorkspaceAllowlist`, `projectDirectoryForTask`, `WORKSPACE_UNREGISTERED_MESSAGE`.
- `destinationHasUsableWorkspace(deps, parent, dest)` (`474-480`): if `dest` allowlist non-empty →
  `true` (unchanged). Else compute `effective` = registry dirs and
  `D = parent.workingDirectory ?? projectDirectoryForTask(deps.db, parent)`; return
  `Boolean(D) && isPathAllowed(D, effective)`. Zero projects → `false`.
- `childExecutionDir` (`460-465`): if `dest` allowlist non-empty → `allowlist[0]` (unchanged);
  else `parent.workingDirectory ?? projectDirectoryForTask(deps.db, parent) ?? ""`.
- `delegateSubtask` (`483-515`) is unchanged: its existing `null` return drives the
  `no_destination` abort (`439-444`, `638-643`) **before** any child is created — no retries.
- `describeAbortReason` (`994-1003`): add `case "no_destination": return "No house can run this
  subtask: register the target directory as a project, or set a workspace allowlist on the
  destination house."` Keep the machine code `abortReason === "no_destination"` (UI/tests depend
  on it). Replace the stale "Mirrors the queue's `resolveWorkspace` rule" docblock.
- `planningDirectory` (`273`) is untouched (HL planning is not an execution gate).

### `src/server/execution/ollama/runtime.ts`
- Line 121: `const allowlist = effectiveWorkspaceAllowlist(db, configuration);`. Lines 326 and
  401 already consume `allowlist`, so no other change. A write/read inside a registered project
  is then classified *inside*; unregistered stays *out*.
- `permissions.ts` unchanged (it receives `pathInsideAllowlist`); update its docblock wording to
  "effective workspace allowlist".

## Exact error string
`"Register this directory as a project, or set a workspace allowlist on the house."`
Surfaces as: (a) queue `tasks.last_error` + a `task_failed` event payload `{ error }`; (b)
orchestrator `no_destination` abort notification body (`abortPlan` → `describeAbortReason`) while
`execution_preferences.plan.abortReason` stays `"no_destination"`.

## Test plan
- **`orchestrator.test.ts`:** `seedWorld` (`184-191`) must register the parent dir
  (`createProject(getDb(), { name, directory: tmpDir, gitInfo: {branch:null,remote:null,dirty:false} })`,
  fresh DB per test so no unique-dir clash) so the `[]` houses (h1/h2) resolve `tmpDir`. Test
  `13 (M2)` (`924-952`) keeps asserting `no_destination` for empty allowlist **with no resolvable
  dir / zero projects**; refresh its comment. Add:
  1. **Regression:** register the parent dir as a project, dest house `[]` → tick delegates a
     child whose `workingDirectory` is that dir (no abort).
  2. **Fail fast:** dest `[]` + `parent.workingDirectory` set to an unregistered tmp dir →
     `no_destination`, `attemptCount === 0`, notification/abort text actionable.
- **`queue-loop.test.ts`:** empty house allowlist + task dir registered as a project → claimed and
  `executeTask` called; empty allowlist + unregistered task dir → status `failed`, event error
  equals the message, runner not called.
- **`workspace-resolution.test.ts` (new):** empty config → project dirs; non-empty config → the
  config array verbatim; zero projects → `[]`; `projectDirectoryForTask` null/point-lookup.
- **`ollama-runtime.test.ts`:** house with `[]` + workspace registered as a project → an `fs_read`
  inside executes (not `ask`); outside remains gated. Existing non-empty tests are unchanged.
- Do **not** weaken assertions to make the suite pass; non-empty-allowlist tests must stay green
  unedited.

## Acceptance criteria
- Empty-allowlist house + `D` inside a registered project runs (HL delegation no longer fails 4×).
- Empty-allowlist house + unregistered `D` (or no `D`/zero projects) fails immediately with the
  exact message; no retries.
- Non-empty allowlists behave byte-identically; Ollama path-inside uses the effective list.
- No schema/migration; `npx tsc --noEmit` clean.

## Gates
```bash
npx tsc --noEmit                    # baseline 0
npm test                            # baseline 1170 (+1 @real skipped); expect +new cases
# free port 3000 first, then:
npm run test:e2e                    # baseline 55
```
Do not run `npm run lint`. No dependency changes.

## Risks
- **`seedWorld` reliance on the buggy path:** houses pass `[]`; without a registered project many
  delegation tests abort. Fix by registering the parent dir (above), not by weakening assertions.
- **Non-empty allowlist + `projectId`, no `workingDirectory`:** the project-directory fallback is
  deliberately gated to empty allowlists to preserve the spec's byte-identity clause. Flag if the
  spec owner wants the broader D rule.
- **`listProjects` cost:** one tiny indexed SELECT per claim (queue) and per delegation decision
  (orchestrator, ≤8 subtasks/tick). Acceptable; only hoist one list per `tickActivePlans` pass if
  profiling shows it. Do not cache across ticks (must not drift from the DB, per spec).
- **No test depended on the old empty-allowlist guard** (searched: no queue/orchestrator test
  asserts "No workspace allowlist configured"), so no test needs deleting.
