/**
 * Migration-chain safety: full chain FROM THE PHASE 1 SCHEMA HEAD.
 *
 * Satisfies docs/IMPLEMENTATION_PLAN.md §10's test strategy ("migration test
 * from Phase 1 schema head"). There is no committed Phase-1 DB snapshot, so we
 * reconstruct it deterministically:
 *
 *   1. Replay only 0000_smiling_starbolt.sql (the Phase-1 head) into a temp DB.
 *   2. Record it as applied in `__drizzle_migrations` using the migrator's OWN
 *      convention (hash = sha256(sql file), created_at = the journal entry's
 *      `when`) so the real migrate() applies 0001…head and skips 0000.
 *   3. Seed the Phase-1 rows a real DB would carry (house/agent/config/project/
 *      task/engine_state).
 *   4. Run the REAL `migrate()` for the whole chain.
 *   5. Assert every seeded row survives, `PRAGMA foreign_key_check` is empty,
 *      the post-Phase-1 columns/tables exist, and CHECKs/FKs/indexes are intact.
 *
 * A second describe seeds a realistic EXECUTION story once the chain's 0001–0003
 * tables exist, then runs the real migrate() for the remaining chain
 * (0004 rebuild + 0005 additive) so data loss through a rebuild is caught here
 * as well.
 *
 * This test FAILS LOUDLY if any migration in the chain drops data or orphans a
 * reference.
 *
 * NOTE: drizzle applies the whole chain in ONE transaction, so an in-file
 * `PRAGMA foreign_keys=OFF` would be a no-op. `src/lib/db/migrate.ts` disables
 * FK enforcement around the migrator and runs `foreign_key_check` after — this
 * test drives exactly that path.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";

const DRIZZLE_DIR = path.resolve(process.cwd(), "drizzle");
const PHASE1_TAG = "0000_smiling_starbolt";
const PHASE1_FILE = path.join(DRIZZLE_DIR, `${PHASE1_TAG}.sql`);

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

function journalEntries(): JournalEntry[] {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Apply one migration's SQL raw (autocommit per statement) + bookkeeping. */
function applyRaw(db: Database.Database, tag: string, when: number): void {
  const sql = fs.readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), "utf8");
  for (const stmt of splitStatements(sql)) db.exec(stmt);
  db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
    crypto.createHash("sha256").update(sql).digest("hex"),
    when,
  );
}

/** Reconstruct the Phase-1 schema + migration bookkeeping. */
function buildPhase1Head(dbPath: string): void {
  const phase1Sql = fs.readFileSync(PHASE1_FILE, "utf8");
  const entry = journalEntries().find((e) => e.tag === PHASE1_TAG);
  if (!entry) throw new Error(`journal has no entry for ${PHASE1_TAG}`);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const stmt of splitStatements(phase1Sql)) db.exec(stmt);

  // Match the migrator's own bookkeeping so 0000 is considered applied.
  const hash = crypto.createHash("sha256").update(phase1Sql).digest("hex");
  db.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
  );
  db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(hash, entry.when);
  db.close();
}

/** Seed the Phase-1 tables (task status is CHECK-locked to queued/cancelled). */
function seedPhase1Rows(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT INTO houses (id,name,description,kind,status) VALUES ('h1','Phase One House','','agent','active')",
  ).run();
  db.prepare("INSERT INTO agents (id,house_id,name,role) VALUES ('ag1','h1','Azriel','knight')").run();
  db.prepare(
    `INSERT INTO agent_configurations (id,agent_id,system_prompt,execution_provider,ai_provider,model_id,workspace_allowlist,tools,permissions,approval_policy,concurrency)
     VALUES ('cfg1','ag1','You are Azriel.','opencode','ollama-cloud','glm-5.3','["/tmp"]','["fs"]','{}','always',1)`,
  ).run();
  db.prepare(
    "INSERT INTO projects (id,name,description,directory,default_model) VALUES ('p1','Phase One Project','','/tmp','glm-5.3')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,title,status,house_id,project_id) VALUES ('t1','Phase One Task','queued','h1','p1')",
  ).run();
  db.prepare("INSERT INTO engine_state (key,value) VALUES ('engine_heartbeat_at','2026-01-01T00:00:00.000Z')").run();
  db.close();
}

/** Seed a realistic execution story once 0001–0003 tables exist. */
function seedExecutionStory(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT INTO execution_sessions (id,task_id,house_id,provider,model_id,status) VALUES ('s1','t1','h1','opencode','glm-5.3','running')",
  ).run();
  db.prepare(
    "INSERT INTO agent_messages (id,session_id,role,content) VALUES ('m1','s1','user','precious')",
  ).run();
  db.prepare(
    "INSERT INTO execution_events (session_id,task_id,house_id,raw_type,type) VALUES ('s1','t1','h1','message','message')",
  ).run();
  db.prepare(
    "INSERT INTO approval_requests (id,session_id,task_id,house_id,provider_request_id,kind,status,title,message) VALUES ('a1','s1','t1','h1','pr1','permission','pending','ti','bo')",
  ).run();
  db.prepare(
    "INSERT INTO artifacts (id,session_id,task_id,kind,content) VALUES ('ar1','s1','t1','result','x')",
  ).run();
  db.prepare(
    "INSERT INTO usage_records (id,session_id,task_id,house_id,model_id,provider) VALUES ('u1','s1','t1','h1','glm-5.3','opencode')",
  ).run();
  db.prepare(
    "INSERT INTO notifications (id,type,house_id,task_id,title,body) VALUES ('n1','system','h1','t1','ti','bo')",
  ).run();
  db.prepare(
    "INSERT INTO subtasks (id,parent_task_id,order_index,plan_id,title) VALUES ('st1','t1',0,'s0','sub')",
  ).run();
  db.prepare(
    "INSERT INTO handoffs (id,parent_task_id,subtask_id,destination_house_id) VALUES ('ho1','t1','st1','h1')",
  ).run();
  db.close();
}

/** Row counts for every non-internal table that exists in a DB. */
function counts(db: Database.Database): Record<string, number> {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>
  )
    .map((t) => t.name)
    .filter((n) => !n.startsWith("sqlite_") && n !== "__drizzle_migrations");
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
  return out;
}

/* ================================================================== */
/* A. Full chain from the Phase 1 head                                 */
/* ================================================================== */

describe("full migration chain from the Phase 1 schema head", () => {
  let tmpDir: string;
  let dbPath: string;
  let beforeCounts: Record<string, number> = {};
  let migrated = false;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-chain-head-"));
    dbPath = path.join(tmpDir, "phase1-head.db");
    buildPhase1Head(dbPath);
    seedPhase1Rows(dbPath);
    {
      const db = new Database(dbPath, { readonly: true });
      beforeCounts = counts(db);
      db.close();
    }
    // Run the REAL boot-time migration (FK-off guard + post foreign_key_check).
    migrate(dbPath);
    migrated = true;
    resetDbForTests();
  });

  afterAll(() => {
    resetDbForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records 0000 as already applied and chains the rest (the Phase-1 head is real)", () => {
    expect(migrated).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    const applied = db
      .prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
      .all() as Array<{ created_at: number }>;
    db.close();
    // 0000 + 0001 + 0002 + 0003 + 0004 + 0005 + 0006 = 7 (head at the time of writing).
    expect(applied.length).toBeGreaterThanOrEqual(7);
    expect(beforeCounts.houses).toBe(1);
  });

  it("preserves every seeded Phase-1 row across the full chain", () => {
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    const after = counts(db);
    for (const [table, n] of Object.entries(beforeCounts)) {
      expect({ table, count: after[table] }).toEqual({ table, count: n });
    }
    const survivors = {
      house: (db.prepare("SELECT COUNT(*) c FROM houses WHERE id='h1'").get() as { c: number }).c,
      agent: (db.prepare("SELECT COUNT(*) c FROM agents WHERE id='ag1'").get() as { c: number }).c,
      project: (db.prepare("SELECT COUNT(*) c FROM projects WHERE id='p1'").get() as { c: number }).c,
      task: (db.prepare("SELECT COUNT(*) c FROM tasks WHERE id='t1'").get() as { c: number }).c,
    };
    expect(survivors).toEqual({ house: 1, agent: 1, project: 1, task: 1 });
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    db.close();
  });

  it("has the post-Phase-1 columns/tables (0003 + 0004 + 0005 + 0006 landed)", () => {
    const db = new Database(dbPath);
    const hasColumn = (table: string, col: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
        (c) => c.name === col,
      );
    const tableExists = (t: string): boolean =>
      (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t) as {
        c: number;
      }).c > 0;

    // 0004 rebuilt agent_messages with tool_calls / tool_call_id.
    expect(hasColumn("agent_messages", "tool_calls")).toBe(true);
    expect(hasColumn("agent_messages", "tool_call_id")).toBe(true);
    // 0003 + 0005 tables.
    expect(tableExists("subtasks")).toBe(true);
    expect(tableExists("handoffs")).toBe(true);
    expect(tableExists("audit_log")).toBe(true);
    // 0007 Stage C adds templates (additive CREATE TABLE).
    expect(tableExists("templates")).toBe(true);
    // 0006 adds tasks.agent_id (nullable, additive).
    expect(hasColumn("tasks", "agent_id")).toBe(true);
    db.close();
  });

  it("keeps indexes, FKs and CHECK constraints intact on the surviving tables", () => {
    const db = new Database(dbPath);
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexNames).toContain("idx_houses_status");
    expect(indexNames).toContain("idx_tasks_status");
    expect(indexNames).toContain("idx_execution_sessions_task");
    expect(indexNames).toContain("idx_audit_created");

    const fkTables = (
      db.prepare("PRAGMA foreign_key_list(tasks)").all() as Array<{ table: string }>
    ).map((r) => r.table);
    expect(fkTables).toContain("houses");
    expect(fkTables).toContain("projects");

    // CHECK constraints still enforce (invalid status is rejected).
    expect(() =>
      db.prepare("INSERT INTO tasks (id,title,status) VALUES ('bad','bad-status','nonsense')").run(),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("is idempotent — a second migrate() is a no-op and preserves rows", () => {
    const before = (() => {
      const db = new Database(dbPath, { readonly: true });
      const c = counts(db);
      db.close();
      return c;
    })();
    migrate(dbPath);
    resetDbForTests();
    const db = new Database(dbPath);
    expect(counts(db)).toEqual(before);
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    db.close();
  });

  it("the additive 0005 audit_log migration emits no fragile in-file PRAGMA toggle", () => {
    // drizzle runs the whole chain in ONE transaction, so an in-file
    // `PRAGMA foreign_keys=OFF` is a no-op; rebuilds rely on migrate.ts instead.
    // Phase 6 Stage A is additive-only (CREATE TABLE audit_log).
    const sql = fs.readFileSync(path.join(DRIZZLE_DIR, "0005_yielding_human_cannonball.sql"), "utf8");
    expect(sql).not.toMatch(/PRAGMA\s+foreign_keys/i);
    expect(sql).toMatch(/CREATE TABLE `audit_log`/);
  });

  it("the 0006 tasks.agent_id migration is ADDITIVE (ADD COLUMN + index, no DROP/rebuild/PRAGMA)", () => {
    const sql = fs.readFileSync(path.join(DRIZZLE_DIR, "0006_multi_agent_tasks.sql"), "utf8");
    expect(sql).not.toMatch(/PRAGMA\s+foreign_keys/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).toMatch(/ALTER TABLE `tasks` ADD `agent_id`/);
    expect(sql).toMatch(/idx_tasks_agent/);
    // ON DELETE SET NULL so deleting an agent preserves task history.
    expect(sql).toMatch(/ON DELETE set null/i);
  });

  it("the 0007 templates migration is ADDITIVE (CREATE TABLE + indexes, no DROP/rebuild/PRAGMA)", () => {
    const sql = fs.readFileSync(path.join(DRIZZLE_DIR, "0007_violet_inertia.sql"), "utf8");
    expect(sql).not.toMatch(/PRAGMA\s+foreign_keys/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).toMatch(/CREATE TABLE `templates`/);
    expect(sql).toMatch(/idx_templates_kind/);
    expect(sql).toMatch(/idx_templates_name_kind/);
    // kind is CHECK-constrained with TEMPLATE_KINDS parity.
    expect(sql).toMatch(/kind in \('house','project'\)/);
  });

  it("0007's templates table exists with the expected shape and indexes", () => {
    const db = new Database(dbPath);
    const cols = (db.prepare("PRAGMA table_info(templates)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "kind",
        "name",
        "description",
        "payload",
        "is_seeded",
        "created_at",
        "updated_at",
      ]),
    );
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexNames).toContain("idx_templates_kind");
    expect(indexNames).toContain("idx_templates_name_kind");
    // The kind CHECK enforces the closed set.
    expect(() =>
      db
        .prepare(
          "INSERT INTO templates (id,kind,name,payload,is_seeded) VALUES ('bad-tpl','spaceship','X','{}',0)",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    db.close();
  });

  it("0006's tasks.agent_id FK is ON DELETE SET NULL and the index exists", () => {
    const db = new Database(dbPath);
    const fks = db.prepare("PRAGMA foreign_key_list(tasks)").all() as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>;
    const agentFk = fks.find((fk) => fk.from === "agent_id");
    expect(agentFk).toBeTruthy();
    expect(agentFk!.table).toBe("agents");
    expect(agentFk!.on_delete.toUpperCase()).toBe("SET NULL");

    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexNames).toContain("idx_tasks_agent");
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    db.close();
  });
});

/* ================================================================== */
/* B. Execution rows survive the destructive 0004 rebuild in-chain     */
/* ================================================================== */

describe("execution history survives the in-chain 0004 rebuild + 0005", () => {
  let tmpDir: string;
  let dbPath: string;
  let beforeCounts: Record<string, number> = {};

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-chain-exec-"));
    dbPath = path.join(tmpDir, "phase1-exec.db");
    const entries = journalEntries();
    const byTag = (tag: string): JournalEntry => {
      const e = entries.find((x) => x.tag === tag);
      if (!e) throw new Error(`missing journal entry ${tag}`);
      return e;
    };

    buildPhase1Head(dbPath);
    seedPhase1Rows(dbPath);
    // Apply 0001–0003 raw (these tables did not exist at Phase 1 head), recording
    // bookkeeping so the real migrate() resumes at 0004.
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    for (const tag of ["0001_cute_juggernaut", "0002_lying_goliath", "0003_smooth_doctor_doom"]) {
      applyRaw(db, tag, byTag(tag).when);
    }
    db.close();

    seedExecutionStory(dbPath);
    {
      const snapshot = new Database(dbPath, { readonly: true });
      beforeCounts = counts(snapshot);
      snapshot.close();
    }

    // The real migrate() now applies 0004 (rebuild) + 0005 (additive).
    migrate(dbPath);
    resetDbForTests();
  });

  afterAll(() => {
    resetDbForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves every pre-existing execution row through the 0004 rebuild", () => {
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    const after = counts(db);
    for (const [table, n] of Object.entries(beforeCounts)) {
      expect({ table, count: after[table] }).toEqual({ table, count: n });
    }
    const survivors = {
      session: (db.prepare("SELECT COUNT(*) c FROM execution_sessions WHERE id='s1'").get() as { c: number }).c,
      message: (db.prepare("SELECT COUNT(*) c FROM agent_messages WHERE id='m1'").get() as { c: number }).c,
      approval: (db.prepare("SELECT COUNT(*) c FROM approval_requests WHERE id='a1'").get() as { c: number }).c,
      artifact: (db.prepare("SELECT COUNT(*) c FROM artifacts WHERE id='ar1'").get() as { c: number }).c,
      usage: (db.prepare("SELECT COUNT(*) c FROM usage_records WHERE id='u1'").get() as { c: number }).c,
      notification: (db.prepare("SELECT COUNT(*) c FROM notifications WHERE id='n1'").get() as { c: number }).c,
    };
    expect(survivors).toEqual({
      session: 1,
      message: 1,
      approval: 1,
      artifact: 1,
      usage: 1,
      notification: 1,
    });
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    db.close();
  });

  it("lands 0005's audit_log and can append/read an entry", () => {
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    db.prepare(
      "INSERT INTO audit_log (id,actor,action,entity_type,entity_id,metadata) VALUES ('aud1','user','create','house','h1','{}')",
    ).run();
    const row = db.prepare("SELECT actor, action FROM audit_log WHERE id='aud1'").get() as {
      actor: string;
      action: string;
    };
    expect(row).toEqual({ actor: "user", action: "create" });
    db.close();
  });
});
