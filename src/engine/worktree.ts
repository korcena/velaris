/**
 * Engine-side worktree isolation helpers (Phase 6.2 Stage S1).
 *
 * When `experimental.worktreeIsolation` is ON and the routed provider is
 * OpenCode, each run executes in a git worktree created through the OpenCode
 * `/experimental/worktree` endpoint. This module owns:
 *   - `resolveWorktree` — validate the ORIGINAL task repo against the HOUSE
 *     allowlist ALONE, then ALWAYS create a fresh worktree for the run.
 *   - `cleanupWorktree` — best-effort terminal cleanup of a session's worktree.
 *   - `sweepWorktrees` — boot-time orphan sweep.
 *
 * ALLOWLIST EXCEPTION (the single documented one, S1.5): worktrees live under
 * `worktreeRoot()` (`.../opencode/worktree`), outside every house allowlist.
 * Only the FINAL RUN directory may be validated against an allowlist augmented
 * with that one root; the SOURCE repo the task points at is always validated
 * against the house allowlist alone, so enabling worktree mode never widens
 * where a task can point.
 *
 * Everything here is flag-gated and OpenCode-only. `resolveWorktree` and the
 * sweep's client calls never run when the flag is OFF, but `cleanupWorktree`
 * and `sweepWorktrees` are called unconditionally by the queue/boot — they are
 * given a client regardless and rely on their own guards (no directory; and the
 * flag check inside `runSweep`). The precise flag-OFF guarantee is: no worktree
 * is created, no session worktree mapping is written, and no worktree event is
 * emitted.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { VelarisDb } from "@/lib/db";
import type { OpencodeClient } from "@/server/opencode";
import { resolveSafePath, worktreeRoot } from "@/lib/paths";
import {
  listSessionsWithWorktrees,
  clearSessionWorktree,
} from "@/server/repositories/execution-repo";
import { getWorktreeIsolationEnabled } from "@/server/repositories/provider-config-repo";
import type { SessionStatus, TaskDto } from "@/shared/types";
import type { TerminalStatus } from "@/server/execution/runner";

/** Default age guard for the orphan sweep: don't race a just-created worktree. */
export const WORKTREE_SWEEP_GRACE_MS = 60 * 60 * 1000; // 1 hour

/** Session statuses that are safe to treat as terminal for cleanup purposes. */
const NON_TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = [
  "pending",
  "running",
  "awaiting_approval",
  "awaiting_input",
  "paused",
];

export interface ResolvedWorktree {
  directory: string;
  branch: string;
}

/**
 * Reduce a task id/title to a path-safe worktree name: lowercase alphanumerics
 * and single dashes only (OpenCode derives the branch as `opencode/<name>`).
 */
export function sanitizeWorktreeName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 60) : "task";
}

/**
 * Resolve the worktree for a task's run:
 *  a. Re-validate the ORIGINAL source repo against the HOUSE allowlist alone
 *     (`resolveSafePath`) — this can never use the augmented run allowlist.
 *  b. ALWAYS create a FRESH worktree via the OpenCode client, bound to that
 *     source repo through the `?directory=` query param.
 *  c. Defensively verify the created worktree's `.git` file points back under
 *     the source repo's `.git/worktrees/` (source-repo binding check). A
 *     mismatch throws so the caller falls back to the normal directory.
 *
 * FRESH-EVERY-RUN (Q3, accepted decision): a prior worktree is deliberately
 * NEVER reused. A previous run's worktree may be dirty (crash / interrupted /
 * reset failed) or may belong to a different source repo after a task edit;
 * reusing it is cross-session contamination. The boot sweep reclaims leftovers.
 *
 * Throws on any failure; the caller (queue) treats isolation as best-effort and
 * falls back to the normal resolved directory.
 */
export async function resolveWorktree(opts: {
  client: OpencodeClient;
  task: TaskDto;
  /** The already-resolved original task repo directory. */
  sourceDirectory: string;
  /** The ROUTED agent's house allowlist (never augmented with the worktree root). */
  houseAllowlist: string[];
}): Promise<ResolvedWorktree> {
  // (a) The source repo must still validate against the house allowlist ALONE.
  const sourceReal = resolveSafePath(opts.sourceDirectory, opts.houseAllowlist);

  // (b) Always create a fresh worktree named after the (unique) task id, bound
  //     to the source repo via the query param (M2). Reuse is never done (M1).
  const name = sanitizeWorktreeName(opts.task.id || opts.task.title);
  const info = await opts.client.createWorktree({ directory: sourceReal, name });
  if (!info.directory) {
    throw new Error("OpenCode createWorktree returned no directory");
  }

  // (c) Source-repo binding check (defensive; best-effort). Even though the
  //     create call is now correctly scoped, verify the freshly created
  //     worktree really belongs to `sourceReal` before using it.
  assertWorktreeBelongsToSource(info.directory, sourceReal);

  return { directory: info.directory, branch: info.branch };
}

/**
 * Assert that `worktreeDirectory`'s `.git` file points under
 * `<sourceDirectory realpath>/.git/worktrees/`. A linked git worktree created
 * by `git worktree add` (which OpenCode uses) writes a `.git` FILE containing
 * `gitdir: <main-repo>/.git/worktrees/<name>`. Guards M2: if OpenCode bound the
 * worktree to the wrong repo, this throws so the queue falls back.
 *
 * Throws when the `.git` file is missing/unreadable, has no `gitdir:` line, or
 * points elsewhere. Callers treat a throw as best-effort isolation failure.
 */
export function assertWorktreeBelongsToSource(
  worktreeDirectory: string,
  sourceDirectory: string,
): void {
  let sourceReal: string;
  try {
    sourceReal = fs.realpathSync(sourceDirectory);
  } catch {
    throw new Error(`source repo not resolvable: ${sourceDirectory}`);
  }
  const expectedPrefix = path.join(sourceReal, ".git", "worktrees") + path.sep;

  let contents: string;
  try {
    contents = fs.readFileSync(path.join(worktreeDirectory, ".git"), "utf8");
  } catch (err) {
    throw new Error(
      `worktree ${worktreeDirectory} has no readable .git file (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(contents);
  const gitdir = match?.[1];
  if (!gitdir) {
    throw new Error(`worktree ${worktreeDirectory} .git file has no gitdir: line`);
  }

  // `gitdir:` is absolute in the live-verified shape, but resolve relative to
  // the worktree dir just in case. realpath both sides so symlink differences
  // cannot cause a false mismatch.
  const absGitdir = path.resolve(worktreeDirectory, gitdir);
  let gitdirReal: string;
  try {
    gitdirReal = fs.realpathSync(absGitdir);
  } catch {
    gitdirReal = absGitdir;
  }
  let prefixReal = expectedPrefix;
  try {
    prefixReal = fs.realpathSync(path.join(sourceReal, ".git")) + path.sep + "worktrees" + path.sep;
  } catch {
    /* keep the unresolved prefix; gitdirReal was best-effort too */
  }

  if (!gitdirReal.startsWith(prefixReal)) {
    throw new Error(
      `worktree ${worktreeDirectory} is not bound to source repo ${sourceReal} (gitdir ${gitdirReal})`,
    );
  }
}

/**
 * Best-effort terminal cleanup (Q3):
 *   - completed          → delete the worktree; on success clear the mapping,
 *                          on failure keep it for the boot sweep.
 *   - failed/aborted/interrupted → reset the worktree (preserve for inspection)
 *                          and keep the mapping.
 *
 * Never deletes a non-terminal session's worktree. Any error is logged and
 * swallowed — cleanup must never affect the runner result.
 */
export async function cleanupWorktree(opts: {
  db: VelarisDb;
  client: OpencodeClient;
  sessionId: string;
  directory: string | null;
  terminalStatus: TerminalStatus;
  log: (msg: string) => void;
}): Promise<void> {
  const { db, client, sessionId, directory, terminalStatus, log } = opts;
  if (!directory) return;
  try {
    if (terminalStatus === "completed") {
      const deleted = await client.deleteWorktree(directory);
      if (deleted) {
        clearSessionWorktree(db, sessionId);
      } else {
        log(`[worktree] delete incomplete for ${directory}; keeping the session mapping for the boot sweep`);
      }
    } else {
      // failed | aborted | interrupted → reset, keep the mapping.
      await client.resetWorktree(directory);
    }
  } catch (err) {
    log(
      `[worktree] cleanup (${terminalStatus}) for ${directory} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** True when `status` is a session status still in flight (must not be swept). */
export function isNonTerminalSessionStatus(status: SessionStatus): boolean {
  return NON_TERMINAL_SESSION_STATUSES.includes(status);
}

/** Read the current branch of a git worktree via the git CLI (no shell). */
function readGitBranch(directory: string): string | null {
  try {
    return (
      execFileSync("git", ["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      })
        .trim()
        .split("\n")[0] || null
    );
  } catch {
    return null;
  }
}

/** Is `directory` (realpath'd) equal to or inside the worktree root? */
function isUnderWorktreeRoot(directory: string, root: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(directory);
  } catch {
    return false;
  }
  return real === root || real.startsWith(root + path.sep);
}

/** realpath with a fallback to the raw path (for referenced-set comparison). */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Bounded await: reject if `p` does not settle within `ms` (never hang boot). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface SweepOptions {
  /** Injected clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** Grace period; worktrees younger than this are left alone. */
  graceMs?: number;
  /** Injected branch reader for tests; defaults to the git CLI. */
  branchOf?: (directory: string) => string | null;
  /** Per-client-call timeout so a hung server cannot stall engine boot. */
  clientTimeoutMs?: number;
}

/** Default per-call bound for the boot sweep's OpenCode client calls. */
export const WORKTREE_SWEEP_CALL_TIMEOUT_MS = 5_000;

/**
 * Boot-time orphan sweep (Q3). Runs only when the worktree flag is ON; when OFF
 * it returns before touching the client, so the default engine boot is
 * unchanged.
 *
 * NEVER throws: the whole sweep is wrapped so a failure/hung server is logged
 * and swallowed — it can never prevent engine boot. Every client call is
 * bounded by `clientTimeoutMs` (default 5s) so a hung server cannot stall
 * startup, and the per-worktree `readGitBranch` failure is non-fatal (the entry
 * is simply skipped).
 *
 * For each OpenCode worktree that is:
 *   - under `worktreeRoot()`,
 *   - on an `opencode/*` branch (branch-pollution guard),
 *   - not referenced by any NON-TERMINAL session (compared via realpath so
 *     symlink/trailing-slash differences cannot mask an in-flight worktree), and
 *   - older than the grace period (avoid racing a just-created worktree),
 * reset then delete it. Idempotent; every action is logged.
 */
export async function sweepWorktrees(
  db: VelarisDb,
  client: OpencodeClient,
  log: (msg: string) => void,
  opts: SweepOptions = {},
): Promise<void> {
  try {
    await runSweep(db, client, log, opts);
  } catch (err) {
    // The sweep is best-effort maintenance; never let it break boot.
    log(`[worktree] sweep failed (ignored; engine will continue): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runSweep(
  db: VelarisDb,
  client: OpencodeClient,
  log: (msg: string) => void,
  opts: SweepOptions,
): Promise<void> {
  if (!getWorktreeIsolationEnabled(db)) return;

  const root = worktreeRoot();
  const now = opts.now ?? (() => Date.now());
  const graceMs = opts.graceMs ?? WORKTREE_SWEEP_GRACE_MS;
  const callTimeoutMs = opts.clientTimeoutMs ?? WORKTREE_SWEEP_CALL_TIMEOUT_MS;
  const branchOf = opts.branchOf ?? readGitBranch;

  let worktrees: string[];
  try {
    worktrees = await withTimeout(
      client.listWorktrees(),
      callTimeoutMs,
      "[worktree] sweep: listWorktrees",
    );
  } catch (err) {
    log(`[worktree] sweep: listWorktrees failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (worktrees.length === 0) return;

  // Worktrees still owned by an in-flight session must never be touched.
  // M4: compare realpath'd paths on both sides so a symlink or trailing-slash
  // difference cannot treat an in-flight worktree as unreferenced.
  const referenced = new Set(
    listSessionsWithWorktrees(db)
      .filter((s) => isNonTerminalSessionStatus(s.status))
      .map((s) => s.worktreeDirectory)
      .filter((d): d is string => !!d)
      .map((d) => safeRealpath(d)),
  );

  for (const dir of worktrees) {
    if (!isUnderWorktreeRoot(dir, root)) {
      log(`[worktree] sweep: skipping ${dir} (outside ${root})`);
      continue;
    }
    if (referenced.has(safeRealpath(dir))) continue;

    // readGitBranch already has a 10s timeout and returns null on any failure;
    // a null/unavailable branch is non-fatal and the entry is skipped.
    const branch = branchOf(dir);
    if (!branch || !branch.startsWith("opencode/")) {
      log(`[worktree] sweep: skipping ${dir} (branch ${branch ?? "unavailable"} is not opencode/*)`);
      continue;
    }

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      continue; // directory vanished between list and stat — nothing to do
    }
    if (now() - mtimeMs < graceMs) {
      log(`[worktree] sweep: skipping ${dir} (younger than grace period)`);
      continue;
    }

    try {
      await withTimeout(client.resetWorktree(dir), callTimeoutMs, "[worktree] sweep: resetWorktree");
      await withTimeout(client.deleteWorktree(dir), callTimeoutMs, "[worktree] sweep: deleteWorktree");
      log(`[worktree] sweep: removed orphaned worktree ${dir} (${branch})`);
    } catch (err) {
      log(
        `[worktree] sweep: failed to remove ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
