/**
 * Engine audit retention maintenance (Phase 6.2 Stage S4 — Q4).
 *
 * The web process must never run background timers that write the DB, so the
 * periodic prune is engine-only (the engine is the single writer for periodic
 * maintenance). Config lives on the default OpenCode provider `extra`
 * (`extra.audit.retentionDays`) and defaults to "keep forever" (`0`/absent).
 *
 * `createAuditPruner` returns a `maybePrune()` guarded by an in-memory
 * `lastPrunedAt` so it runs at most once per hour, no matter how often the
 * engine's 2s tick calls it. The clock + readers are injectable for
 * deterministic unit tests (no real timers). Every error is swallowed + logged
 * so a prune can never break the tick/boot.
 */

import type Database from "better-sqlite3";
import { pruneAuditLog } from "@/server/repositories/audit-repo";
import { getAuditRetentionDays } from "@/server/repositories/provider-config-repo";

/** Minimum spacing between prune attempts (boot run + at most hourly). */
export const AUDIT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface AuditPrunerDeps {
  /** The raw better-sqlite3 connection the engine already owns. */
  db: Database.Database;
  log: (msg: string) => void;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable prune fn. Defaults to `pruneAuditLog`. */
  prune?: (db: Database.Database, retentionDays: number) => number;
  /** Injectable retention reader. Defaults to `getAuditRetentionDays`. */
  getRetentionDays?: (db: Database.Database) => number;
}

export interface AuditPruner {
  /** Prune if the interval has elapsed and retention is configured; returns deleted count. */
  maybePrune(): number;
}

export function createAuditPruner(deps: AuditPrunerDeps): AuditPruner {
  const now = deps.now ?? Date.now;
  const prune = deps.prune ?? pruneAuditLog;
  const getRetentionDays = deps.getRetentionDays ?? getAuditRetentionDays;
  let lastPrunedAt: number | null = null;

  return {
    maybePrune(): number {
      const at = now();
      if (lastPrunedAt !== null && at - lastPrunedAt < AUDIT_PRUNE_INTERVAL_MS) {
        return 0;
      }
      // Record the attempt before doing the work so a failure does not cause a
      // retry storm on the next tick (maintenance is best-effort).
      lastPrunedAt = at;
      try {
        const retentionDays = getRetentionDays(deps.db);
        if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
          deps.log("[audit-maintenance] retention not configured — keeping audit log forever");
          return 0;
        }
        const deleted = prune(deps.db, retentionDays);
        deps.log(
          `[audit-maintenance] pruned ${deleted} audit row(s) older than ${retentionDays} day(s)`,
        );
        return deleted;
      } catch (err) {
        deps.log(
          `[audit-maintenance] prune failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 0;
      }
    },
  };
}
