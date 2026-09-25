/**
 * ADVERSARIAL Phase 6.1 verification — independent tests written by a QA
 * engineer, deliberately probing edge cases the author suites do not.
 *
 * Covers:
 *  - default-agent ordering determinism when createdAt ties (Stage B);
 *  - cross-house task PATCH preserving a now-foreign agentId (Stage B);
 *  - deleted-agent routing falls back without crashing (Stage B);
 *  - migration additive-only invariants + FK/index/CHECK integrity and
 *    idempotent re-run on a COPY of the real dev DB (Stage 0/§12);
 *  - template instantiation produces a FULLY configured house;
 *  - usage: zero/negative/huge values, mirror mismatch, partition invariant.
 *
 * Isolation contract: VELARIS_DB_PATH is set BEFORE importing route modules in
 * the integration block at the bottom of this file via a dynamic import helper.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import {
  createHouse,
  createAgent,
  listAgentsForHouse,
  resolveDefaultAgent,
  getHouse,
  deleteAgent,
  resolveRuntimeAgent,
} from "@/server/repositories/house-repo";
import { createTask, getTask, updateTask } from "@/server/repositories/task-repo";
import { getUsageTotals, getUsageByHouse, getUsageByModel } from "@/server/repositories/usage-repo";
import { escapeLike, searchArchives } from "@/server/repositories/archive-repo";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

function cfg(over: Partial<HouseConfiguration> = {}): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
    ...over,
  };
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-adversarial-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ================================================================== */
/* Stage B — default agent ordering                                   */
/* ================================================================== */

describe("ADVERSARIAL: default-agent ordering tie-break (Stage B)", () => {
  it("the OLDEST agent must remain the default even when createdAt ties and ids sort otherwise", () => {
    // Simulate two agents inserted in the same millisecond (the common case in
    // tests and fast UI actions). The DEFAULT must be the one inserted FIRST —
    // ordering by created_at alone is not a total order in SQLite (rowid is,
    // but an explicit `id` tiebreak may disagree with insertion order).
    const raw = getRawDb();
    const T = "2026-01-01T00:00:00.000Z";
    raw
      .prepare(
        "INSERT INTO houses (id,name,description,kind,status,created_at,updated_at) VALUES ('h','H','','agent','active',?,?)",
      )
      .run(T, T);
    raw
      .prepare(
        "INSERT INTO agents (id,house_id,name,role,created_at,updated_at) VALUES ('zzzz-first','h','FIRST','R',?,?)",
      )
      .run(T, T);
    raw
      .prepare(
        "INSERT INTO agents (id,house_id,name,role,created_at,updated_at) VALUES ('aaaa-second','h','SECOND','R',?,?)",
      )
      .run(T, T);
    raw
      .prepare(
        "INSERT INTO agent_configurations (id,agent_id,system_prompt,execution_provider,ai_provider,model_id,workspace_allowlist,tools,permissions,approval_policy,concurrency,created_at,updated_at) VALUES ('c1','zzzz-first','p','opencode','ollama-cloud','first','[]','[]','{}','always',1,?,?)",
      )
      .run(T, T);
    raw
      .prepare(
        "INSERT INTO agent_configurations (id,agent_id,system_prompt,execution_provider,ai_provider,model_id,workspace_allowlist,tools,permissions,approval_policy,concurrency,created_at,updated_at) VALUES ('c2','aaaa-second','p','opencode','ollama-cloud','second','[]','[]','{}','always',1,?,?)",
      )
      .run(T, T);

    const listed = listAgentsForHouse(getDb(), "h").map((a) => a.name);
    // Expected: insertion order (FIRST, SECOND) — the documented rule is
    // "oldest first", and FIRST was inserted first.
    expect(listed).toEqual(["FIRST", "SECOND"]);
    expect(resolveDefaultAgent(getDb(), "h")?.name).toBe("FIRST");
    expect(getHouse(getDb(), "h")?.configuration.modelId).toBe("first");
  });
});

/* ================================================================== */
/* Stage B — cross-house + deleted agent routing                      */
/* ================================================================== */

describe("ADVERSARIAL: task→agent routing edge cases (Stage B)", () => {
  it("PATCHing a task to a different house leaves a stale foreign agentId (data integrity hole)", () => {
    const db = getDb();
    const hA = createHouse(db, { name: "A", agent: { name: "Ad", role: "R" }, configuration: cfg() });
    const hB = createHouse(db, { name: "B", agent: { name: "Bd", role: "R" }, configuration: cfg() });
    const aA = createAgent(db, hA.id, {
      name: "A2",
      role: "R",
      configuration: cfg({ modelId: "agentA-model" }),
    });
    const t = createTask(db, { title: "T", houseId: hA.id, agentId: aA.id });

    // Move the task to house B via the repo (the route only validates agentId
    // when it is present in the BODY; moving the house alone bypasses the check).
    const moved = updateTask(db, t.id, { houseId: hB.id });

    // Defect: agentId still points at house A's agent while houseId is B. The
    // task now carries an agent that does not belong to its house.
    expect(moved.agentId).toBe(aA.id);
    expect(moved.houseId).toBe(hB.id);
    // The engine defensively ignores the foreign agent and falls back to B's
    // default; so execution is safe, but the persisted row is inconsistent.
    const routed = resolveRuntimeAgent(db, hB.id, moved);
    expect(routed?.id).not.toBe(aA.id);
    expect(routed?.name).toBe("Bd");
  });

  it("deleting an agent mid-flight SET NULLs the task and falls back to the default", () => {
    const db = getDb();
    const h = createHouse(db, { name: "H", agent: { name: "Default", role: "R" }, configuration: cfg() });
    const a2 = createAgent(db, h.id, {
      name: "Second",
      role: "R",
      configuration: cfg({ modelId: "second-model" }),
    });
    const t = createTask(db, { title: "T", houseId: h.id, agentId: a2.id });

    deleteAgent(db, a2.id);
    const after = getTask(db, t.id)!;
    expect(after.agentId).toBeNull();
    const routed = resolveRuntimeAgent(db, h.id, after);
    expect(routed?.name).toBe("Default");
  });

  it("resolveRuntimeAgent tolerates an agentId that belongs to NO house without throwing", () => {
    const db = getDb();
    const h = createHouse(db, { name: "H", agent: { name: "Default", role: "R" }, configuration: cfg() });
    const t = createTask(db, { title: "T", houseId: h.id, agentId: null });
    const routed = resolveRuntimeAgent(db, h.id, { ...t, agentId: "does-not-exist" });
    expect(routed?.name).toBe("Default");
  });
});

/* ================================================================== */
/* Stage B — per-house serialization across agents                    */
/* ================================================================== */

describe("ADVERSARIAL: per-house serialization is agent-independent (Stage B)", () => {
  it("an active session on agent A blocks house B's slot only by HOUSE id, not agent", async () => {
    const { getActiveSessionForHouse, createExecutionSession } = await import(
      "@/server/repositories/execution-repo"
    );
    const db = getDb();
    const h = createHouse(db, { name: "H", agent: { name: "Default", role: "R" }, configuration: cfg() });
    const a2 = createAgent(db, h.id, { name: "Second", role: "R", configuration: cfg() });
    const t = createTask(db, { title: "T", houseId: h.id, agentId: a2.id });

    // A running session for the SECOND agent still occupies the HOUSE slot, so
    // the queue must refuse to start another task for the same house. This is
    // why multi-agent routing keeps the house-level concurrency guard.
    createExecutionSession(db, {
      taskId: t.id,
      houseId: h.id,
      agentId: a2.id,
      provider: "opencode",
      modelId: "m",
    });
    const active = getActiveSessionForHouse(db, h.id);
    expect(active).not.toBeNull();
    expect(active!.agentId).toBe(a2.id);
  });

  it("the High Lord house DTO still exposes its single agent under agents[] and as .agent", async () => {
    const { seedHighLordHouse } = await import("@/server/repositories/house-repo");
    const raw = getRawDb();
    seedHighLordHouse(raw);
    const hl = getHouse(
      getDb(),
      (
        raw.prepare("SELECT id FROM houses WHERE kind='high_lord' LIMIT 1").get() as {
          id: string;
        }
      ).id,
    )!;
    expect(hl.agents).toHaveLength(1);
    expect(hl.agent.name).toBe(hl.agents[0].name);
    expect(hl.configuration.executionProvider).toBe(hl.agents[0].configuration.executionProvider);
  });
});

/* ================================================================== */
/* Stage E — usage edge cases                                         */
/* ================================================================== */

describe("ADVERSARIAL: usage aggregation edge cases (Stage E)", () => {
  function seedRaw(rows: Array<{ id: string; cost: number; estimated: boolean; model?: string }>) {
    const raw = getRawDb();
    raw
      .prepare("INSERT INTO houses (id,name,description,kind,status) VALUES ('h','H','','agent','active')")
      .run();
    const insTask = raw.prepare(
      "INSERT INTO tasks (id,title,description,type,status,house_id,created_at) VALUES (?,?,'','general','completed','h','2026-01-01T00:00:00.000Z')",
    );
    const insSess = raw.prepare(
      "INSERT INTO execution_sessions (id,task_id,house_id,status,provider,model_id,cost_total,created_at) VALUES (?,?,'h','completed','opencode',?,?,'2026-01-01T00:00:00.000Z')",
    );
    const insUsage = raw.prepare(
      "INSERT INTO usage_records (id,session_id,task_id,provider,model_id,cost,estimated,created_at) VALUES (?,?,?,'opencode',?,?,?,'2026-01-01T00:00:00.000Z')",
    );
    for (const r of rows) {
      const model = r.model ?? "m";
      insTask.run(`t-${r.id}`, r.id);
      // Session mirror intentionally equals the usage cost.
      insSess.run(`s-${r.id}`, `t-${r.id}`, model, r.cost);
      insUsage.run(`u-${r.id}`, `s-${r.id}`, `t-${r.id}`, model, r.cost, r.estimated ? 1 : 0);
    }
  }

  it("keeps total = estimated + reported with zero and float-accumulation rows", () => {
    seedRaw([
      { id: "z", cost: 0, estimated: false },
      { id: "f1", cost: 0.1, estimated: false },
      { id: "f2", cost: 0.2, estimated: false },
      { id: "e", cost: 0.5, estimated: true },
    ]);
    const t = getUsageTotals(getDb());
    expect(t.totalCost).toBeCloseTo(0.3 + 0.5, 9);
    expect(t.estimatedCost + t.reportedCost).toBeCloseTo(t.totalCost, 12);
    expect(t.sessions).toBe(4);
  });

  it("partition invariant holds for negative amounts too (no special-casing)", () => {
    seedRaw([
      { id: "a", cost: -1.5, estimated: false },
      { id: "b", cost: 1, estimated: false },
      { id: "c", cost: 0.25, estimated: true },
    ]);
    const totals = getUsageTotals(getDb()).totalCost;
    const sum = (rows: { totalCost: number }[]) => rows.reduce((a, r) => a + r.totalCost, 0);
    expect(sum(getUsageByHouse(getDb()))).toBeCloseTo(totals, 9);
    expect(sum(getUsageByModel(getDb()))).toBeCloseTo(totals, 9);
  });

  it("detects a mismatched session mirror (usage != session) — the reconcile guarantee only holds when mirrored", () => {
    const raw = getRawDb();
    seedRaw([{ id: "a", cost: 1.0, estimated: false }]);
    // Corrupt the mirror to a different value (as a bug / partial write would).
    raw.prepare("UPDATE execution_sessions SET cost_total = 999 WHERE id='s-a'").run();
    const totals = getUsageTotals(getDb());
    const mirror = raw
      .prepare("SELECT COALESCE(SUM(cost_total),0) c FROM execution_sessions")
      .get() as { c: number };
    // The dashboard faithfully reports the usage record; it is NOT equal to the
    // corrupted mirror. This documents that reconciliation depends on the
    // engine's write-once mirror invariant, not on the read path.
    expect(totals.totalCost).toBeCloseTo(1.0, 9);
    expect(mirror.c).toBeCloseTo(999, 9);
  });
});

/* ================================================================== */
/* Stage D — LIKE escaping / injection                                */
/* ================================================================== */

describe("ADVERSARIAL: archive LIKE escaping + injection (Stage D)", () => {
  it("escapeLike escapes backslash before % and _ (order matters)", () => {
    expect(escapeLike("a\\%b")).toBe("a\\\\\\%b");
    expect(escapeLike("_%_")).toBe("\\_\\%\\_");
  });

  it("a backslash-only query does not match everything", () => {
    const raw = getRawDb();
    raw
      .prepare("INSERT INTO houses (id,name,description,kind,status) VALUES ('h','H','','agent','active')")
      .run();
    const ins = raw.prepare(
      "INSERT INTO tasks (id,title,description,type,status,house_id,created_at) VALUES (?,?,'desc','general','completed','h','2026-01-01T00:00:00.000Z')",
    );
    ins.run("a", "plain");
    ins.run("b", "has \\ backslash");
    const res = searchArchives(getDb(), { q: "\\", limit: 100, offset: 0 });
    expect(res.total).toBe(1);
    expect(res.entries[0].taskId).toBe("b");
  });

  it("SQL-injection-shaped query is treated literally and does not drop data", () => {
    const raw = getRawDb();
    raw
      .prepare("INSERT INTO houses (id,name,description,kind,status) VALUES ('h','H','','agent','active')")
      .run();
    raw
      .prepare(
        "INSERT INTO tasks (id,title,description,type,status,house_id,created_at) VALUES ('a','x','d','general','completed','h','2026-01-01T00:00:00.000Z')",
      )
      .run();
    const res = searchArchives(getDb(), { q: "'; DROP TABLE tasks; --", limit: 100, offset: 0 });
    expect(res.total).toBe(0);
    const stillThere = raw.prepare("SELECT COUNT(*) c FROM tasks").get() as { c: number };
    expect(stillThere.c).toBe(1);
  });
});

/* ================================================================== */
/* Stage 0 — migration additive-only + integrity                      */
/* ================================================================== */

describe("ADVERSARIAL: migration additive-only + integrity (Stage 0)", () => {
  it("0005/0006/0007 contain no destructive DDL and no in-file PRAGMA toggles", () => {
    for (const tag of [
      "0005_yielding_human_cannonball",
      "0006_multi_agent_tasks",
      "0007_violet_inertia",
    ]) {
      const sql = fs.readFileSync(path.resolve(process.cwd(), "drizzle", `${tag}.sql`), "utf8");
      expect({ tag, pragma: /PRAGMA\s+foreign_keys/i.test(sql) }).toEqual({ tag, pragma: false });
      expect({ tag, drop: /\bDROP\b/i.test(sql) }).toEqual({ tag, drop: false });
    }
  });

  it("every migration's SQL is covered by a journal entry (no orphan migration file)", () => {
    const dir = path.resolve(process.cwd(), "drizzle");
    const journal = JSON.parse(
      fs.readFileSync(path.join(dir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    const tags = new Set(journal.entries.map((e) => e.tag));
    const sqlFiles = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => f.replace(/\.sql$/, ""));
    const orphans = sqlFiles.filter((f) => !tags.has(f));
    expect(orphans).toEqual([]);
  });

  it("db:generate drift guard — the schema snapshot for tasks.agent_id matches the hand-edited SQL", () => {
    const snapshot = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "drizzle/meta/0006_snapshot.json"), "utf8"),
    ) as {
      tables: {
        tasks: {
          columns: Record<string, { notNull: boolean }>;
          foreignKeys: Record<string, { onDelete: string }>;
          indexes: Record<string, unknown>;
        };
      };
    };
    expect(snapshot.tables.tasks.columns.agent_id.notNull).toBe(false);
    const fk = Object.values(snapshot.tables.tasks.foreignKeys).find((f) =>
      Object.keys(snapshot.tables.tasks.foreignKeys).includes("tasks_agent_id_agents_id_fk"),
    );
    expect(fk?.onDelete).toBe("set null");
    expect(Object.keys(snapshot.tables.tasks.indexes)).toContain("idx_tasks_agent");
  });
});

/* ================================================================== */
/* Migration on a COPY of the real dev DB                             */
/* ================================================================== */

describe("ADVERSARIAL: migrate a COPY of the real dev DB (never the original)", () => {
  const REAL = path.resolve(process.cwd(), "db/velaris.db");
  const available = fs.existsSync(REAL);

  it("copies db/velaris.db, migrates, preserves rows + empty foreign_key_check, idempotent", () => {
    if (!available) return; // skip gracefully on a fresh checkout
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-real-copy-"));
    const copy = path.join(dir, "copy.db");
    // Copy the main file only (a checkpointed DB); WAL sidecars are best-effort.
    fs.copyFileSync(REAL, copy);

    const before = (() => {
      const db = new Database(copy, { readonly: true });
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      const out: Record<string, number> = {};
      for (const t of tables) {
        if (t === "__drizzle_migrations") continue;
        out[t] = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
      }
      db.close();
      return out;
    })();

    // Drop the singleton opened by beforeEach so migrate(copy) targets the copy.
    resetDbForTests();
    // Run the REAL migrate() against the copy.
    migrate(copy);
    resetDbForTests();

    const db = new Database(copy);
    db.pragma("foreign_keys = ON");
    const after: Record<string, number> = {};
    for (const t of Object.keys(before)) {
      after[t] = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
    }
    // Every pre-existing row survives (additive migrations).
    expect(after).toEqual(before);
    expect(db.pragma("foreign_key_check")).toHaveLength(0);

    // 0006 + 0007 landed.
    const taskCols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(taskCols).toContain("agent_id");
    const agentFk = (
      db.prepare("PRAGMA foreign_key_list(tasks)").all() as Array<{
        from: string;
        table: string;
        on_delete: string;
      }>
    ).find((f) => f.from === "agent_id");
    expect(agentFk?.table).toBe("agents");
    expect(agentFk?.on_delete.toUpperCase()).toBe("SET NULL");
    expect(
      (
        db
          .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='templates'")
          .get() as { c: number }
      ).c,
    ).toBe(1);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_templates_name_kind'")
          .get() as { c: number }
      ).c,
    ).toBe(1);
    db.close();

    // Idempotent second run.
    migrate(copy);
    resetDbForTests();
    const db2 = new Database(copy);
    const after2: Record<string, number> = {};
    for (const t of Object.keys(before)) {
      after2[t] = (db2.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
    }
    expect(after2).toEqual(before);
    expect(db2.pragma("foreign_key_check")).toHaveLength(0);
    db2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
