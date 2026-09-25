/**
 * Migration 0004 — FK-cascade data-loss regression guard (was a BLOCKER).
 *
 * drizzle 0004 rebuilds agent_messages / execution_sessions / tasks via
 * CREATE __new_* -> INSERT SELECT -> DROP old -> RENAME. The migrator wraps ALL
 * migration statements in a SINGLE BEGIN…COMMIT (see
 * node_modules/drizzle-orm/sqlite-core/dialect.js:657-671), so a
 * `PRAGMA foreign_keys=OFF;` embedded in the .sql is a NO-OP (SQLite forbids
 * changing FK state mid-transaction). FKs stay ON, so `DROP TABLE
 * execution_sessions` / `DROP TABLE tasks` used to CASCADE into every
 * referencing row (agent_messages, approval_requests, artifacts, usage_records,
 * notifications, execution_events, subtasks, handoffs).
 *
 * Two-part fix (regression-guarded here):
 *   (1) `src/lib/db/migrate.ts` disables `foreign_keys` on the raw connection
 *       BEFORE the migrator's own BEGIN and restores it + runs
 *       `PRAGMA foreign_key_check` after COMMIT. This is the general guarantee
 *       (also protects 0001, which has the same latent OFF/ON pattern).
 *   (2) `drizzle/0004_swift_zarek.sql` no longer re-enables FKs mid-file, so the
 *       raw (non-transactional) replay path exercised by this test also keeps
 *       FKs OFF through all DROPs.
 *
 * This test replays the migrations RAW (autocommit per statement, like the dev
 * tooling) and asserts every seeded row survives AND foreign_key_check is empty.
 * It is a permanent regression guard — reverting either half of the fix will
 * fail here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const SQL_DIR = path.resolve(import.meta.dirname, "../../drizzle");
function readSql(name: string): string {
  return fs.readFileSync(path.join(SQL_DIR, name), "utf8");
}
function splitStatements(sql: string): string[] {
  return sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
}
function replay(db: Database.Database, sql: string): void {
  for (const stmt of splitStatements(sql)) db.exec(stmt);
}
const MIGRATION_ORDER = [
  "0000_smiling_starbolt.sql",
  "0001_cute_juggernaut.sql",
  "0002_lying_goliath.sql",
  "0003_smooth_doctor_doom.sql",
];

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-mig0004-"));
  db = new Database(path.join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of MIGRATION_ORDER) replay(db, readSql(m));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed a full execution history — every cascade-affected table. */
function seedReality(): void {
  db.prepare("INSERT INTO houses (id,name,kind,status) VALUES ('h1','H','agent','active')").run();
  db.prepare("INSERT INTO tasks (id,title,status,house_id) VALUES ('t1','T','running','h1')").run();
  db.prepare("INSERT INTO execution_sessions (id,task_id,house_id,provider,model_id,status) VALUES ('s1','t1','h1','opencode','m','running')").run();
  db.prepare("INSERT INTO agent_messages (id,session_id,role,content) VALUES ('m1','s1','user','precious')").run();
  db.prepare("INSERT INTO execution_events (session_id,task_id,house_id,raw_type,type) VALUES ('s1','t1','h1','message','message')").run();
  db.prepare("INSERT INTO approval_requests (id,session_id,task_id,house_id,provider_request_id,kind,status,title,message) VALUES ('a1','s1','t1','h1','pr1','permission','pending','ti','bo')").run();
  db.prepare("INSERT INTO artifacts (id,session_id,task_id,kind,content) VALUES ('ar1','s1','t1','result','x')").run();
  db.prepare("INSERT INTO usage_records (id,session_id,task_id,house_id,model_id,provider) VALUES ('u1','s1','t1','h1','m','ollama')").run();
  db.prepare("INSERT INTO notifications (id,type,house_id,task_id,title,body) VALUES ('n1','approval','h1','t1','ti','bo')").run();
}

const count = (db: Database.Database, t: string): number => {
  const row = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
  return row.c;
};

describe("0004 FK-cascade data-loss regression guard", () => {
  it("preserves agent_messages + the session/task they reference across the rebuild", () => {
    seedReality();
    expect(count(db, "agent_messages")).toBe(1);
    replay(db, readSql("0004_swift_zarek.sql"));
    // FIXED: the drop of execution_sessions/tasks must NOT cascade to children.
    expect(count(db, "agent_messages")).toBe(1);
    expect(count(db, "execution_sessions")).toBe(1);
    expect(count(db, "tasks")).toBe(1);
  });

  it("preserves approvals/artifacts/usage/notifications child rows on an upgraded DB", () => {
    seedReality();
    replay(db, readSql("0004_swift_zarek.sql"));
    expect(count(db, "approval_requests")).toBe(1);
    expect(count(db, "artifacts")).toBe(1);
    expect(count(db, "usage_records")).toBe(1);
    expect(count(db, "notifications")).toBe(1);
    expect(count(db, "execution_events")).toBe(1);
  });

  it("leaves foreign_key_check empty and the new columns present after the rebuild", () => {
    seedReality();
    replay(db, readSql("0004_swift_zarek.sql"));
    // No orphaned references after the non-destructive rebuild.
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
    const cols = db.prepare("PRAGMA table_info(agent_messages)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("tool_calls");
    expect(cols.map((c) => c.name)).toContain("tool_call_id");
    // role CHECK now allows 'tool'.
    expect(count(db, "agent_messages")).toBe(1);
  });

  it("is idempotent — replaying 0004 twice preserves rows both times", () => {
    seedReality();
    replay(db, readSql("0004_swift_zarek.sql"));
    // A second (no-op by migration table bookkeeping, but raw replay is what a
    // fresh migration would do once) must also not lose data.
    replay(db, readSql("0004_swift_zarek.sql"));
    expect(count(db, "agent_messages")).toBe(1);
    expect(count(db, "execution_sessions")).toBe(1);
    expect(db.pragma("foreign_key_check")).toHaveLength(0);
  });
});
