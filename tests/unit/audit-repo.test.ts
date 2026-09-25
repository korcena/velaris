/**
 * Unit tests — audit log repository (Phase 6 Stage A / decision Q9).
 *
 * Covers:
 *  - insert returns an id and list round-trips the DTO (metadata parsed)
 *  - filters: entityType / entityId / actor / action / from, pagination
 *  - malformed JSON metadata is tolerated (parseJson fallback {})
 *  - `recordAudit` swallows DB errors (never throws into the request path)
 *  - the actor CHECK constraint mirrors AUDIT_ACTORS
 *
 * Each test gets a fresh temp DB (migrate → run → teardown).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { recordAudit, listAuditLog } from "@/server/repositories/audit-repo";
import { AUDIT_ACTORS } from "@/shared/constants";

let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-audit-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordAudit / listAuditLog", () => {
  it("inserts a row and round-trips the DTO with parsed metadata", () => {
    const db = getDb();
    const id = recordAudit(db, {
      actor: "user",
      action: "create",
      entityType: "house",
      entityId: "house-1",
      metadata: { name: "House of Shadows" },
    });
    expect(id).toBeTruthy();

    const entries = listAuditLog(db);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id,
      actor: "user",
      actorAgentId: null,
      action: "create",
      entityType: "house",
      entityId: "house-1",
      metadata: { name: "House of Shadows" },
    });
    expect(entries[0].createdAt).toBeTruthy();
  });

  it("defaults actor to 'user' and metadata to an empty object", () => {
    const db = getDb();
    recordAudit(db, { action: "delete", entityType: "project", entityId: "p1" });
    const entry = listAuditLog(db)[0];
    expect(entry.actor).toBe("user");
    expect(entry.actorAgentId).toBeNull();
    expect(entry.metadata).toEqual({});
  });

  it("filters by entityType, entityId, actor and action", () => {
    const db = getDb();
    recordAudit(db, { action: "create", entityType: "house", entityId: "h1" });
    recordAudit(db, { action: "update", entityType: "house", entityId: "h2" });
    recordAudit(db, { action: "create", entityType: "project", entityId: "p1" });
    recordAudit(db, { action: "respond", entityType: "approval", entityId: "a1", actor: "engine" });

    expect(listAuditLog(db, { entityType: "house" })).toHaveLength(2);
    expect(listAuditLog(db, { entityType: "house", entityId: "h1" })).toHaveLength(1);
    expect(listAuditLog(db, { action: "create" })).toHaveLength(2);
    expect(listAuditLog(db, { actor: "engine" })).toHaveLength(1);
    expect(listAuditLog(db, { entityType: "approval", actor: "user" })).toHaveLength(0);
  });

  it("honours limit/offset newest-first", () => {
    const db = getDb();
    // Seed with explicit ascending timestamps so order is deterministic.
    recordAudit(db, { id: "a1", action: "create", entityType: "house", entityId: "h1" });
    const raw = getRawDb();
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", "a1");
    recordAudit(db, { id: "a2", action: "update", entityType: "house", entityId: "h1" });
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", "a2");
    recordAudit(db, { id: "a3", action: "delete", entityType: "house", entityId: "h1" });
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2026-01-03T00:00:00.000Z", "a3");

    const firstPage = listAuditLog(db, { limit: 2 });
    expect(firstPage.map((e) => e.id)).toEqual(["a3", "a2"]);
    const secondPage = listAuditLog(db, { limit: 2, offset: 2 });
    expect(secondPage.map((e) => e.id)).toEqual(["a1"]);
  });

  it("filters by `from` timestamp (strictly newer)", () => {
    const db = getDb();
    recordAudit(db, { id: "old", action: "create", entityType: "house", entityId: "h1" });
    recordAudit(db, { id: "new", action: "update", entityType: "house", entityId: "h1" });
    const raw = getRawDb();
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", "old");
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2026-01-05T00:00:00.000Z", "new");

    const after = listAuditLog(db, { from: "2026-01-03T00:00:00.000Z" });
    expect(after.map((e) => e.id)).toEqual(["new"]);
  });

  it("tolerates malformed metadata JSON (falls back to {})", () => {
    const db = getDb();
    recordAudit(db, { id: "bad", action: "create", entityType: "house", entityId: "h1" });
    getRawDb().prepare("UPDATE audit_log SET metadata = ? WHERE id = ?").run("{not-json", "bad");
    expect(listAuditLog(db)[0].metadata).toEqual({});
  });
});

describe("recordAudit never throws into the request path", () => {
  it("returns null and logs when the DB write fails", () => {
    const db = getDb();
    const broken = {
      insert: () => {
        throw new Error("boom");
      },
    } as unknown as ReturnType<typeof getDb>;
    // Silence the expected console.error for the assertion window.
    const original = console.error;
    console.error = () => {};
    let result: string | null = null;
    try {
      result = recordAudit(broken, {
        action: "create",
        entityType: "house",
        entityId: "h1",
      });
    } finally {
      console.error = original;
    }
    expect(result).toBeNull();
    // The real DB is untouched.
    expect(listAuditLog(db)).toHaveLength(0);
  });
});

describe("actor CHECK constraint parity", () => {
  it("accepts every AUDIT_ACTORS value", () => {
    const db = getDb();
    for (const actor of AUDIT_ACTORS) {
      const id = recordAudit(db, { actor, action: "create", entityType: "house", entityId: actor });
      expect(id).toBeTruthy();
    }
    expect(listAuditLog(db)).toHaveLength(AUDIT_ACTORS.length);
  });

  it("rejects an unknown actor via the CHECK constraint", () => {
    const db = getDb();
    const original = console.error;
    console.error = () => {};
    try {
      expect(() =>
        recordAudit(db, {
          actor: "robot" as never,
          action: "create",
          entityType: "house",
          entityId: "h1",
        }),
      ).not.toThrow(); // recordAudit swallows it...
    } finally {
      console.error = original;
    }
    // ...but nothing was written.
    expect(listAuditLog(db)).toHaveLength(0);
  });
});
