/**
 * Unit tests — archive repository/service (Phase 6 Stage D).
 *
 * Golden dataset: 100+ terminal tasks (the §10 acceptance criterion
 * "archives search by task/house/text over ≥100 historical sessions"), each
 * with sessions + artifacts + messages, proving search, filters, pagination,
 * total, empty results, and LIKE escaping.
 *
 * Temp DB per test (migrate → seed → teardown).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { escapeLike, hasArchiveFts, searchArchives } from "@/server/repositories/archive-repo";
import { searchArchivesService } from "@/server/services/archive-service";
import { createHouse } from "@/server/repositories/house-repo";
import type { HouseConfiguration } from "@/shared/types";

const SESSION_COUNT = 120; // ≥100 requirement

let tmpDir: string;
let dbPath: string;
let houseId: string;

function makeConfig(): HouseConfiguration {
  return {
    systemPrompt: "You are an archivist.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

/**
 * Seed 120 terminal tasks under two houses, one session each, plus a result
 * artifact on every 5th task and a message on every 7th. Task i is given a
 * searchable marker so text filtering is deterministic:
 *   - title  "Quest <i> alpha" for even i, "Quest <i> beta" for odd i
 *   - description contains "needle-<i>"
 *   - artifact content "RESULT-MARKER-<i>"
 *   - message content "MESSAGE-MARKER-<i>"
 */
function seedGoldenDataset(): void {
  const db = getDb();
  const raw = getRawDb();

  const houseA = createHouse(db, {
    name: "Archive House A",
    agent: { name: "A", role: "r" },
    configuration: makeConfig(),
  });
  houseId = houseA.id;
  const houseB = createHouse(db, {
    name: "Archive House B",
    agent: { name: "B", role: "r" },
    configuration: makeConfig(),
  });

  const insertTask = raw.prepare(
    `INSERT INTO tasks (id, title, description, type, priority, status, house_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'medium', ?, ?, ?, ?)`,
  );
  const insertSession = raw.prepare(
    `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
     VALUES (?, ?, ?, 'completed', 'opencode', 'glm-5.3', ?, ?)`,
  );
  const insertArtifact = raw.prepare(
    `INSERT INTO artifacts (id, session_id, task_id, kind, content, created_at)
     VALUES (?, ?, ?, 'result', ?, ?)`,
  );
  const insertMessage = raw.prepare(
    `INSERT INTO agent_messages (id, session_id, role, content, created_at)
     VALUES (?, ?, 'agent', ?, ?)`,
  );
  const insertUsage = raw.prepare(
    `INSERT INTO usage_records (id, session_id, task_id, house_id, model_id, provider, cost, estimated, created_at)
     VALUES (?, ?, ?, ?, 'glm-5.3', 'opencode', 0.01, 0, ?)`,
  );

  for (let i = 1; i <= SESSION_COUNT; i++) {
    const taskId = `task-${i}`;
    const sessionId = `sess-${i}`;
    const status = i % 3 === 0 ? "failed" : i % 5 === 0 ? "cancelled" : "completed";
    // Spread created_at across days so date filters are testable.
    const created = new Date(Date.UTC(2026, 0, 1 + (i % 20), 12, 0, 0)).toISOString();
    const title = `Quest ${i} ${i % 2 === 0 ? "alpha" : "beta"}`;
    insertTask.run(
      taskId,
      title,
      `Description with needle-${i}-end`,
      i % 4 === 0 ? "research" : "general",
      status,
      i % 2 === 0 ? houseA.id : houseB.id,
      created,
      created,
    );
    insertSession.run(sessionId, taskId, i % 2 === 0 ? houseA.id : houseB.id, created, created);
    insertUsage.run(`usage-${i}`, sessionId, taskId, i % 2 === 0 ? houseA.id : houseB.id, created);
    if (i % 5 === 0) {
      insertArtifact.run(`art-${i}`, sessionId, taskId, `RESULT-MARKER-${i}`, created);
    }
    if (i % 7 === 0) {
      insertMessage.run(`msg-${i}`, sessionId, `MESSAGE-MARKER-${i}`, created);
    }
  }
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-archive-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  seedGoldenDataset();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function search(q: Partial<Parameters<typeof searchArchives>[1]> = {}) {
  return searchArchives(getDb(), {
    limit: 25,
    offset: 0,
    ...q,
  });
}

/* ================================================================== */
/* Golden dataset: ≥100 sessions                                      */
/* ================================================================== */

describe("archives golden dataset (≥100 sessions)", () => {
  it("seeds 120 terminal tasks each with a session", () => {
    const raw = getRawDb();
    const tasks = raw.prepare("SELECT COUNT(*) c FROM tasks").get() as { c: number };
    const sessions = raw.prepare("SELECT COUNT(*) c FROM execution_sessions").get() as {
      c: number;
    };
    expect(tasks.c).toBe(SESSION_COUNT);
    expect(sessions.c).toBe(SESSION_COUNT);
    expect(tasks.c).toBeGreaterThanOrEqual(100);
  });

  it("returns total = 120 and paginates (default page excludes running/non-terminal)", () => {
    const page1 = search({ limit: 25, offset: 0 });
    expect(page1.total).toBe(SESSION_COUNT);
    expect(page1.entries).toHaveLength(25);

    const page2 = search({ limit: 25, offset: 25 });
    expect(page2.total).toBe(SESSION_COUNT);
    expect(page2.entries).toHaveLength(25);
    // Pages do not overlap.
    const ids1 = new Set(page1.entries.map((e) => e.taskId));
    expect(page2.entries.some((e) => ids1.has(e.taskId))).toBe(false);

    const last = search({ limit: 25, offset: 100 });
    expect(last.entries).toHaveLength(20);
  });

  it("search by TASK title (text) matches only the expected rows", () => {
    const res = search({ q: "Quest 42", limit: 100 });
    expect(res.total).toBe(1);
    expect(res.entries[0].title).toBe("Quest 42 alpha");
  });

  it("search by description text (needle-<i>-end)", () => {
    const res = search({ q: "needle-7-end", limit: 100 });
    expect(res.total).toBe(1);
    expect(res.entries[0].taskId).toBe("task-7");
  });

  it("search by result-artifact content (text lives outside tasks)", () => {
    const res = search({ q: "RESULT-MARKER-55", limit: 100 });
    expect(res.total).toBe(1);
    expect(res.entries[0].taskId).toBe("task-55");
    expect(res.entries[0].summarySnippet).toContain("RESULT-MARKER-55");
  });

  it("search by agent-message content", () => {
    const res = search({ q: "MESSAGE-MARKER-49", limit: 100 });
    expect(res.total).toBe(1);
    expect(res.entries[0].taskId).toBe("task-49");
  });

  it("search by HOUSE filter", () => {
    const res = search({ houseId, limit: 100 });
    // Even-numbered tasks belong to house A (60 of 120).
    expect(res.total).toBe(60);
    expect(res.entries.every((e) => e.houseId === houseId)).toBe(true);
    expect(res.entries[0].houseName).toBe("Archive House A");
  });

  it("combines text + house + status filters", () => {
    const res = search({ q: "alpha", houseId, status: "failed", limit: 100 });
    // Even tasks (alpha) in house A whose i % 3 === 0.
    expect(res.total).toBeGreaterThan(0);
    expect(res.entries.every((e) => e.status === "failed" && e.houseId === houseId)).toBe(true);
  });

  it("filters by date range (created_at)", () => {
    const res = search({ from: "2026-01-10T00:00:00.000Z", to: "2026-01-12T23:59:59.999Z", limit: 100 });
    expect(res.total).toBeGreaterThan(0);
    expect(
      res.entries.every(
        (e) => e.createdAt >= "2026-01-10T00:00:00.000Z" && e.createdAt <= "2026-01-12T23:59:59.999Z",
      ),
    ).toBe(true);
  });

  it("aggregates sessionCount + cost per task", () => {
    const res = search({ q: "Quest 10 ", limit: 10 });
    expect(res.entries[0].sessionCount).toBe(1);
    expect(res.entries[0].cost).toBeCloseTo(0.01, 6);
  });

  it("returns an empty result set (total 0) for a non-matching query", () => {
    const res = search({ q: "no-such-text-anywhere" });
    expect(res.entries).toEqual([]);
    expect(res.total).toBe(0);
  });
});

/* ================================================================== */
/* LIKE escaping                                                      */
/* ================================================================== */

describe("LIKE wildcard escaping", () => {
  it("escapeLike escapes %, _ and the escape char", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("c\\d")).toBe("c\\\\d");
    expect(escapeLike("plain")).toBe("plain");
  });

  it("a literal '%' query matches NOTHING (not everything)", () => {
    // Without escaping, '%' would match every task. With escaping, no task
    // contains a literal percent sign.
    const res = search({ q: "%", limit: 100 });
    expect(res.total).toBe(0);
  });

  it("a literal '_' query matches only rows containing an underscore", () => {
    const raw = getRawDb();
    raw
      .prepare("UPDATE tasks SET description = 'has under_score here' WHERE id = 'task-1'")
      .run();
    const res = search({ q: "_", limit: 100 });
    expect(res.total).toBe(1);
    expect(res.entries[0].taskId).toBe("task-1");
  });

  it("a '%' in the middle of a query is treated literally", () => {
    const raw = getRawDb();
    raw.prepare("UPDATE tasks SET title = 'discount 50% off' WHERE id = 'task-2'").run();
    const match = search({ q: "50%" });
    expect(match.total).toBe(1);
    expect(match.entries[0].taskId).toBe("task-2");
    // A task that merely starts with "discount 50" (no %) must not match.
    const noMatch = search({ q: "50%zzz" });
    expect(noMatch.total).toBe(0);
  });
});

/* ================================================================== */
/* Phase 6.2 Stage S2: additive FTS5 index (automatic-if-present)     */
/* ================================================================== */

describe("archives FTS5 index (automatic-if-present, LIKE fallback)", () => {
  it("the migration makes archives_fts present and the FTS path is used", () => {
    expect(hasArchiveFts(getRawDb())).toBe(true);
    // A normal multi-token text search is served by the index and still finds
    // the task by title.
    const res = search({ q: "Quest 42", limit: 100 });
    expect(res.total).toBe(1);
    expect(res.entries[0].taskId).toBe("task-42");
  });

  it("with FTS present, artifact and message text still match with the same totals", () => {
    // These two assertions are the regression proof: FTS aggregates artifact
    // and message text for the task, so the golden searches are unchanged.
    const artifact = search({ q: "RESULT-MARKER-55", limit: 100 });
    expect(artifact.total).toBe(1);
    expect(artifact.entries[0].taskId).toBe("task-55");

    const message = search({ q: "MESSAGE-MARKER-49", limit: 100 });
    expect(message.total).toBe(1);
    expect(message.entries[0].taskId).toBe("task-49");

    // Broad text + filters return the same totals as before.
    expect(search({ q: "alpha", limit: 100 }).total).toBe(60);
    expect(search({ q: "Quest 10 ", limit: 10 }).entries[0].taskId).toBe("task-10");
  });

  it("does not throw on FTS-hostile user input (quotes, operators, wildcards)", () => {
    for (const q of ['"', '""', "*", "-", "OR", "NEAR", "(", ")", '"*', 'a"b', "%", "_", "\\"]) {
      expect(() => search({ q, limit: 100 })).not.toThrow();
      // A lone quote / operator must not match everything.
      expect(search({ q, limit: 100 }).total).toBe(0);
    }
    expect(() => search({ q: '  "  *  -  ', limit: 100 })).not.toThrow();
  });

  it("falls back to LIKE when the FTS table is absent", () => {
    const raw = getRawDb();
    raw.exec("DROP TABLE archives_fts");
    expect(hasArchiveFts(raw)).toBe(false);

    // Same golden searches, same totals, via the retained LIKE path.
    const artifact = search({ q: "RESULT-MARKER-55", limit: 100 });
    expect(artifact.total).toBe(1);
    expect(artifact.entries[0].taskId).toBe("task-55");

    const message = search({ q: "MESSAGE-MARKER-49", limit: 100 });
    expect(message.total).toBe(1);
    expect(message.entries[0].taskId).toBe("task-49");

    expect(search({ q: "Quest 42", limit: 100 }).total).toBe(1);
    expect(search({ q: "alpha", limit: 100 }).total).toBe(60);
    expect(search({ q: "no-such-text-anywhere" }).total).toBe(0);
  });

  it("keeps the wildcard-literal LIKE semantics on both paths", () => {
    const raw = getRawDb();
    // '%' routes to LIKE (FTS tokenises it away); no task contains a literal
    // percent yet, so it matches nothing rather than everything.
    expect(search({ q: "%", limit: 100 }).total).toBe(0);

    raw
      .prepare("UPDATE tasks SET description = 'has under_score here' WHERE id = 'task-1'")
      .run();
    expect(search({ q: "_", limit: 100 }).total).toBe(1);

    raw.prepare("UPDATE tasks SET title = 'discount 50% off' WHERE id = 'task-2'").run();
    expect(search({ q: "50%", limit: 100 }).total).toBe(1);
    expect(search({ q: "50%zzz", limit: 100 }).total).toBe(0);
  });
});

/* ================================================================== */
/* Service: pagination defaults + cap + validation                    */
/* ================================================================== */

describe("archive service", () => {
  it("applies the default limit (25) and a hard cap of 100", () => {
    const dflt = searchArchivesService(getDb(), {});
    expect(dflt.limit).toBe(25);
    expect(dflt.offset).toBe(0);
    expect(dflt.entries).toHaveLength(25);

    const capped = searchArchivesService(getDb(), { limit: "100" });
    expect(capped.limit).toBe(100);
    expect(capped.entries.length).toBeLessThanOrEqual(100);
    // Above the cap is rejected by zod (not silently clamped).
    expect(() => searchArchivesService(getDb(), { limit: "250" })).toThrow();
  });

  it("rejects an out-of-range/unknown query with a ZodError", () => {
    expect(() => searchArchivesService(getDb(), { status: "running" })).toThrow();
    expect(() => searchArchivesService(getDb(), { limit: "0" })).toThrow();
    expect(() => searchArchivesService(getDb(), { status: "nonsense" })).toThrow();
  });

  it("exposes total across pages but only the requested page", () => {
    const page = searchArchivesService(getDb(), { limit: "10", offset: "10" });
    expect(page.total).toBe(SESSION_COUNT);
    expect(page.entries).toHaveLength(10);
    expect(page.limit).toBe(10);
    expect(page.offset).toBe(10);
  });
});
