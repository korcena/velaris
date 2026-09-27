/**
 * Unit tests — engine audit retention maintenance (Phase 6.2 Stage S4 — Q4).
 *
 * `createAuditPruner` takes injectable clock/readers so the "boot + at most
 * once per hour" guard is deterministic (no real timers). The seam only ever
 * calls the injected prune fn; the real SQL prune is covered in
 * tests/unit/audit-repo.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { createAuditPruner, AUDIT_PRUNE_INTERVAL_MS } from "@/engine/audit-maintenance";

/** A stand-in raw connection — the injected prune ignores it. */
const fakeDb = {} as Database.Database;

function harness(opts: {
  retentionDays?: number;
  now?: () => number;
}) {
  const prune = vi.fn(() => 3);
  const getRetentionDays = vi.fn(() => opts.retentionDays ?? 0);
  const log = vi.fn();
  const pruner = createAuditPruner({
    db: fakeDb,
    log,
    now: opts.now,
    prune,
    getRetentionDays,
  });
  return { pruner, prune, getRetentionDays, log };
}

describe("createAuditPruner", () => {
  it("prunes on the first call and respects the configured retention", () => {
    const { pruner, prune, getRetentionDays, log } = harness({ retentionDays: 30 });
    expect(pruner.maybePrune()).toBe(3);
    expect(getRetentionDays).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(fakeDb, 30);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("pruned 3 audit row(s)"));
  });

  it("is a no-op (keep forever) when retention is 0 / absent", () => {
    const { pruner, prune, log } = harness({ retentionDays: 0 });
    expect(pruner.maybePrune()).toBe(0);
    expect(prune).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("keeping audit log forever"));
  });

  it("runs at most once per interval and again after it elapses", () => {
    let nowMs = 1_000_000;
    const { pruner, prune } = harness({ retentionDays: 30, now: () => nowMs });

    expect(pruner.maybePrune()).toBe(3);
    // Same instant / within the interval → guard blocks the second attempt.
    expect(pruner.maybePrune()).toBe(0);
    nowMs += AUDIT_PRUNE_INTERVAL_MS - 1;
    expect(pruner.maybePrune()).toBe(0);
    expect(prune).toHaveBeenCalledTimes(1);

    // Interval elapsed → prune runs again.
    nowMs += 1;
    expect(pruner.maybePrune()).toBe(3);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it("records the attempt before pruning so a failure does not retry every tick", () => {
    const prune = vi.fn(() => {
      throw new Error("disk full");
    });
    const now = vi.fn(() => 5_000);
    const log = vi.fn();
    const pruner = createAuditPruner({
      db: fakeDb,
      log,
      now,
      prune,
      getRetentionDays: () => 30,
    });

    expect(pruner.maybePrune()).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("prune failed"));
    // Second call within the interval is suppressed despite the failure.
    expect(pruner.maybePrune()).toBe(0);
    expect(prune).toHaveBeenCalledTimes(1);
  });
});
