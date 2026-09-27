# Workspace Resolution — Design

**Date:** 2026-09-27
**Status:** Approved (design)
**Supersedes:** the earlier "A + B" plan for the High Lord delegation failure

## Problem

A High Lord plan that delegated a subtask to a seeded house failed with:

```
{"error":"No workspace allowlist configured"}
```

after four retries, aborting the parent with `retries_exhausted`.

Root cause: the **orchestrator and the queue disagree** about what an empty
`workspaceAllowlist` means.

- `orchestrator.destinationHasUsableWorkspace` treats an empty destination
  allowlist as usable **when the parent task carries a working directory**
  (children inherit the parent's directory), and its docblock claims this
  "mirrors the queue's `resolveWorkspace` rule".
- `queue.resolveWorkspace` (and `paths.resolveSafePath`, which the Ollama tool
  guard also calls) rejects an empty allowlist **unconditionally**, before it
  ever looks at the task's directory.

Because all ten seeded houses ship with `workspaceAllowlist: []` by design (the
user was expected to fill them in), *any* High Lord delegation to an
unconfigured house is delegated and then guaranteed to fail at claim time. The
Phase 4 intent — children run in the parent's validated project directory — was
never actually executable.

## Decision

**An empty house `workspaceAllowlist` means "bounded by the registered projects",
not "cannot run".** The trust anchor moves from the house allowlist to the
user-curated project registry, while a non-empty allowlist remains fully
restrictive.

This keeps the following true:

- Houses can work in multiple workspaces (the allowlist stays an array, and the
  project registry is naturally multi-root).
- Per-house narrowing is still available (set a non-empty allowlist).
- There is no path to execute in an arbitrary directory: an empty-allowlist
  house may only run inside a registered project directory.

## Core concept: one effective-allowlist function

A single resolver is used everywhere execution is gated:

```
effectiveWorkspaceAllowlist(db, configuration):
  configuration.workspaceAllowlist.length > 0
    ? configuration.workspaceAllowlist        // unchanged: fully restrictive
    : listProjects(db).map(p => p.directory)  // new: bounded by the registry
```

Every gate that today reads `configuration.workspaceAllowlist` reads the
**effective** list instead. "Empty allowlist" stops meaning "cannot run" and
starts meaning "bounded by your project registry".

## Behavior

- **Quest directory `D`** = `task.workingDirectory` ?? the task's project
  directory.
- **Fallback (`D` absent), non-empty allowlist:** unchanged — use
  `allowlist[0]`.
- **Fallback (`D` absent), empty allowlist:** do **not** arbitrarily pick the
  first registered project. Fail with the actionable message. (A house with no
  allowlist and a task with no directory/project has no principled anchor;
  guessing would be surprising and could run in an unintended repo.)
- If neither a directory nor a valid fallback exists, the run fails with the
  actionable message.
- `D` must resolve (realpath + path-segment containment) inside the effective
  allowlist.
- **Empty-allowlist house + `D` inside a registered project → runs.** This
  fixes the High Lord delegation failure out of the box.
- **Empty-allowlist house + `D` in an unregistered directory → fails** with an
  actionable message:
  *"Register this directory as a project, or set a workspace allowlist on the
  house."*
- **Non-empty allowlist → exactly as today.** The project registry is not
  consulted; the house is fully restrictive.
- **Zero registered projects + empty allowlist → nothing runs**, with the same
  actionable message (no silent widening).

## Touchpoints (measured blast radius)

The word "allowlist" gates execution in four places; all must use the effective
list so they cannot disagree:

1. **`engine/queue.ts` `resolveWorkspace`** — replace the unconditional
   empty-allowlist failure (~line 389) with effective-allowlist resolution
   (realpath + containment). This is the gate that produced the observed error.
2. **Ollama tool guard** (`server/execution/ollama/runtime.ts` +
   `ollama/tools/permissions.ts`) — the runtime computes `pathInsideAllowlist`
   via `resolveSafePath`/`computePathInside` against
   `configuration.workspaceAllowlist`. Pass the **effective** list so that a
   run inside a registered project is correctly classified as *inside* the
   workspace (otherwise every tool write would be treated as out-of-bounds and
   mis-gated). This is the same effective list the queue validated `D` against,
   so the two always agree.
3. **`engine/orchestrator.ts` `destinationHasUsableWorkspace` /
   `childExecutionDir`** — use the same rule so the orchestrator and queue
   finally agree. An empty destination allowlist is usable iff the effective
   (project-backed) allowlist resolves a directory for the child.
4. **Worktree path (Phase 6.2 S1.5)** — validate the source repo and the final
   worktree directory against the **effective** allowlist + `worktreeRoot()`
   (shape unchanged; only the base list swaps from
   `configuration.workspaceAllowlist` to the effective list).

## Failure fast

When a subtask's destination has no usable workspace, `delegateSubtask` returns
`null` and the orchestrator aborts immediately with a clear reason (existing
`no_destination` path) instead of delegating a child the queue is guaranteed to
reject. This removes the four wasted retries and the raw DB error. The abort
message should name the cause actionably (project not registered / house
allowlist empty).

## Security model

- The trust anchor becomes the **project registry** (`projects.directory`),
  which is user-curated and each entry is already validated absolute + exists +
  is a directory (`assertValidDirectory`).
- A non-empty allowlist remains the way to lock a house to specific roots.
- There is **no** path to run in an arbitrary directory through an
  empty-allowlist house; `POST /api/tasks` still cannot smuggle an arbitrary
  `workingDirectory` past the gate.
- The effective list is computed from the same DB in both processes; no new
  schema, no cache that can drift.

## Non-goals

- No schema change, no migration.
- No change to how house allowlists are edited, or to `HouseConfiguration`.
- No change to `POST /api/tasks` trust: an arbitrary `workingDirectory` still
  cannot run unless it is inside the effective allowlist.
- Does not introduce a global "workspace root" setting (the project registry is
  the anchor; a global root was rejected as a second, redundant concept).
- Worktree isolation semantics are unchanged apart from the base list swap.
- The Quest Board "delete posting" feature is a **separate** spec.

## Compatibility

- Non-empty-allowlist houses are byte-identical to today.
- Empty-allowlist houses change from "never runs" to "runs inside a registered
  project". This is the intended fix and the only behavioral change.

## Testing

- **Empty allowlist + `D` inside a registered project → runs** (the real
  regression case: a High Lord parent with a project directory delegating to a
  seeded empty-allowlist house now executes instead of failing 4×).
- **Empty allowlist + `D` in an unregistered directory → clear actionable
  failure**, no retries.
- **Non-empty allowlist unchanged** — inside passes, outside fails, exactly as
  before.
- **Ollama path-inside** uses the effective list: a tool write inside a
  registered project is classified *inside*; outside stays *out*.
- **Orchestrator/queue agreement** — the M2/unresolvable tests are updated to
  the new intent (empty allowlist + a resolvable project dir delegates; empty
  allowlist + no resolvable dir aborts fast with the actionable reason).
- **Zero projects + empty allowlist → actionable failure.**

## Rollout

Single change set; no migration; no data backfill. Update the docblocks in
`queue.resolveWorkspace`, `paths.resolveSafePath`, and
`orchestrator.destinationHasUsableWorkspace` to describe the effective-allowlist
contract and remove the now-false "mirrors the queue" claim.
