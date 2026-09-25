/**
 * Phase 6 (Stage A, migration 0005) data-loss guard on a seeded copy of a REAL
 * database — mirror of `migration-0004-migrate-path.test.ts`.
 *
 * It copies `db/velaris.db` (the dev seed DB at migration head 0004), seeds a
 * row in every table the new migration could touch (and a full execution story),
 * runs the REAL `migrate()` through the boot path, and asserts every row
 * survives, `PRAGMA foreign_key_check` is empty, and `audit_log` was created.
 *
 * Portability (same as the 0004 test): on a fresh checkout there is no
 * gitignored `db/velaris.db`, so the suite skips gracefully rather than failing.
 *
 * The migration is ADDITIVE ONLY (CREATE TABLE audit_log) and emits NO in-file
 * `PRAGMA foreign_keys` toggle — drizzle runs the chain in one transaction, so
 * such a toggle would be a no-op; `src/lib/db/migrate.ts` owns the FK guard.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";

const SEED_DB = path.resolve(process.cwd(), "db/velaris.db");
const seedAvailable = fs.existsSync(SEED_DB);

let tmpDir: string;
let upgradePath: string;
let upgraded = false;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-mig0005-"));
  upgradePath = path.join(tmpDir, "ugprade.db");
  if (!seedAvailable) return;

  fs.copyFileSync(SEED_DB, upgradePath);

  // Seed a full execution story into the copy BEFORE migrate(), as a real
  // pre-upgrade database would have. The real DB is at head 0004, so all these
  // tables/columns already exist.
  const db = new Database(upgradePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Reuse an existing house if present; otherwise create a self-contained one.
  const existingHouse = db.prepare("SELECT id FROM houses LIMIT 1").get() as { id: string } | undefined;
  const houseId = existingHouse?.id ?? "house-phase6-seed";
  if (!existingHouse) {
    db.prepare(
      "INSERT INTO houses (id,name,description,kind,status) VALUES (?,?,?, 'agent','active')",
    ).run(houseId, "Phase Six Seed House", "");
    db.prepare("INSERT INTO agents (id,house_id,name,role) VALUES ('ag-p6',?,'Azriel','knight')").run(houseId);
    db.prepare(
      `INSERT INTO agent_configurations (id,agent_id,system_prompt,execution_provider,ai_provider,model_id,workspace_allowlist,tools,permissions,approval_policy,concurrency)
       VALUES ('cfg-p6','ag-p6','You are Azriel.','opencode','ollama-cloud','glm-5.3','["/tmp"]','["fs"]','{}','always',1)`,
    ).run();
  }

  db.prepare(
    "INSERT INTO tasks (id,title,status,house_id) VALUES ('task-p6','Phase 6 survivor','running',?)",
  ).run(houseId);
  db.prepare(
    "INSERT INTO execution_sessions (id,task_id,house_id,provider,model_id,status) VALUES ('sess-p6','task-p6',?,'opencode','glm-5.3','running')",
  ).run(houseId);
  db.prepare(
    "INSERT INTO agent_messages (id,session_id,role,content) VALUES ('msg-p6','sess-p6','user','precious phase 6 data')",
  ).run();
  db.prepare(
    "INSERT INTO execution_events (session_id,task_id,house_id,raw_type,type) VALUES ('sess-p6','task-p6',?,'message','message')",
  ).run(houseId);
  db.prepare(
    "INSERT INTO approval_requests (id,session_id,task_id,house_id,provider_request_id,kind,status,title,message) VALUES ('apr-p6','sess-p6','task-p6',?,'pr-p6','permission','pending','ti','bo')",
  ).run(houseId);
  db.prepare(
    "INSERT INTO artifacts (id,session_id,task_id,kind,content) VALUES ('art-p6','sess-p6','task-p6','result','x')",
  ).run();
  db.prepare(
    "INSERT INTO usage_records (id,session_id,task_id,house_id,model_id,provider) VALUES ('u-p6','sess-p6','task-p6',?,'glm-5.3','opencode')",
  ).run(houseId);
  db.prepare(
    "INSERT INTO notifications (id,type,house_id,task_id,title,body) VALUES ('n-p6','system',?,'task-p6','ti','bo')",
  ).run(houseId);
  db.prepare(
    "INSERT INTO subtasks (id,parent_task_id,order_index,plan_id,title) VALUES ('st-p6','task-p6',0,'s0','sub')",
  ).run();
  db.prepare(
    "INSERT INTO handoffs (id,parent_task_id,subtask_id,destination_house_id) VALUES ('ho-p6','task-p6','st-p6',?)",
  ).run(houseId);
  db.close();

  // Run the real boot-time migration on the copy.
  migrate(upgradePath);
  upgraded = true;
  resetDbForTests();
});

afterAll(() => {
  resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const count = (db: Database.Database, table: string, where = "1=1"): number =>
  (db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get() as { c: number }).c;

describe("0005 additive migration on a seeded copy of the real DB", () => {
  it("preserves every pre-existing execution row", () => {
    if (!upgraded) return;
    const db = new Database(upgradePath);
    db.pragma("foreign_keys = ON");
    const survivors = {
      task: count(db, "tasks", "id='task-p6'"),
      session: count(db, "execution_sessions", "id='sess-p6'"),
      message: count(db, "agent_messages", "id='msg-p6'"),
      approval: count(db, "approval_requests", "id='apr-p6'"),
      artifact: count(db, "artifacts", "id='art-p6'"),
      usage: count(db, "usage_records", "id='u-p6'"),
      notification: count(db, "notifications", "id='n-p6'"),
      subtask: count(db, "subtasks", "id='st-p6'"),
      handoff: count(db, "handoffs", "id='ho-p6'"),
    };
    expect(survivors).toEqual({
      task: 1,
      session: 1,
      message: 1,
      approval: 1,
      artifact: 1,
      usage: 1,
      notification: 1,
      subtask: 1,
      handoff: 1,
    });
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    db.close();
  });

  it("creates audit_log with the expected shape and accepts a user row", () => {
    if (!upgraded) return;
    const db = new Database(upgradePath);
    db.pragma("foreign_keys = ON");
    const cols = (db.prepare("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "actor",
        "actor_agent_id",
        "action",
        "entity_type",
        "entity_id",
        "metadata",
        "created_at",
      ]),
    );
    db.prepare(
      "INSERT INTO audit_log (id,actor,action,entity_type,entity_id,metadata) VALUES ('aud-p6','user','create','house','h-p6','{}')",
    ).run();
    expect(count(db, "audit_log", "id='aud-p6'")).toBe(1);
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    db.close();
  });

  it("is idempotent — a second migrate() is a no-op and preserves rows", () => {
    if (!upgraded) return;
    migrate(upgradePath);
    resetDbForTests();
    const db = new Database(upgradePath);
    expect(count(db, "agent_messages", "id='msg-p6'")).toBe(1);
    expect(count(db, "audit_log", "id='aud-p6'")).toBe(1);
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    db.close();
  });

  it("0007 creates templates (additive) and accepts a seeded-style row", () => {
    if (!upgraded) return;
    const db = new Database(upgradePath);
    db.pragma("foreign_keys = ON");
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
    db.prepare(
      "INSERT INTO templates (id,kind,name,description,payload,is_seeded) VALUES ('tpl-p6','house','Migrated Tpl','d','{}',1)",
    ).run();
    expect(count(db, "templates", "id='tpl-p6'")).toBe(1);
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    db.close();
  });

  it("0006 adds nullable tasks.agent_id (additive) with SET NULL and preserves task history", () => {
    if (!upgraded) return;
    const db = new Database(upgradePath);
    db.pragma("foreign_keys = ON");

    // The column exists and is nullable.
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const agentCol = cols.find((c) => c.name === "agent_id");
    expect(agentCol).toBeTruthy();
    expect(agentCol!.notnull).toBe(0);

    // The FK is ON DELETE SET NULL against agents.
    const agentFk = (
      db.prepare("PRAGMA foreign_key_list(tasks)").all() as Array<{
        from: string;
        table: string;
        on_delete: string;
      }>
    ).find((fk) => fk.from === "agent_id");
    expect(agentFk).toBeTruthy();
    expect(agentFk!.on_delete.toUpperCase()).toBe("SET NULL");

    // The seeded task survives; pointing it at an agent then deleting the agent
    // must NOT destroy the task (history preserved).
    const agent = db.prepare("SELECT id FROM agents LIMIT 1").get() as { id: string } | undefined;
    if (agent) {
      db.prepare("UPDATE tasks SET agent_id = ? WHERE id = 'task-p6'").run(agent.id);
      // Only delete the agent if it isn't the house's only one — otherwise use a
      // throwaway agent to exercise SET NULL without tripping the app-level guard.
      db.prepare(
        "INSERT INTO agents (id,house_id,name,role) SELECT 'ag-p6-tmp', house_id, 'Tmp', 'R' FROM agents WHERE id = ?",
      ).run(agent.id);
      db.prepare("UPDATE tasks SET agent_id = 'ag-p6-tmp' WHERE id = 'task-p6'").run();
      db.prepare("DELETE FROM agents WHERE id = 'ag-p6-tmp'").run();
    }
    const task = db
      .prepare("SELECT title, agent_id FROM tasks WHERE id = 'task-p6'")
      .get() as { title: string; agent_id: string | null };
    expect(task.title).toBe("Phase 6 survivor");
    expect(task.agent_id).toBeNull(); // SET NULL, task retained
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    db.close();
  });
});
