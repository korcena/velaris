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
import {
  recordAudit,
  listAuditLog,
  pruneAuditLog,
  toAuditCsv,
  AUDIT_CSV_HEADER,
} from "@/server/repositories/audit-repo";
import { AUDIT_ACTORS } from "@/shared/constants";
import type { AuditLogDto } from "@/shared/types";

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

  it("filters by `to` timestamp (inclusive upper bound)", () => {
    const db = getDb();
    recordAudit(db, { id: "old", action: "create", entityType: "house", entityId: "h1" });
    recordAudit(db, { id: "new", action: "update", entityType: "house", entityId: "h1" });
    const raw = getRawDb();
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", "old");
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2026-01-05T00:00:00.000Z", "new");

    const upTo = listAuditLog(db, { to: "2026-01-03T00:00:00.000Z" });
    expect(upTo.map((e) => e.id)).toEqual(["old"]);
    // Boundary is inclusive.
    expect(listAuditLog(db, { to: "2026-01-05T00:00:00.000Z" }).map((e) => e.id)).toEqual(["new", "old"]);
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

describe("pruneAuditLog (Phase 6.2 S4 retention)", () => {
  it("deletes only rows older than the cutoff and returns the count", () => {
    const db = getDb();
    recordAudit(db, { id: "ancient", action: "create", entityType: "house", entityId: "h1" });
    recordAudit(db, { id: "recent", action: "update", entityType: "house", entityId: "h1" });
    const raw = getRawDb();
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", "ancient");
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run(new Date().toISOString(), "recent");

    const deleted = pruneAuditLog(raw, 30);
    expect(deleted).toBe(1);
    expect(listAuditLog(db).map((e) => e.id)).toEqual(["recent"]);
  });

  it("is a no-op for retentionDays 0 / negative / non-finite", () => {
    const db = getDb();
    const raw = getRawDb();
    recordAudit(db, { id: "old", action: "create", entityType: "house", entityId: "h1" });
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "old");

    expect(pruneAuditLog(raw, 0)).toBe(0);
    expect(pruneAuditLog(raw, -5)).toBe(0);
    expect(pruneAuditLog(raw, Number.NaN)).toBe(0);
    expect(pruneAuditLog(raw, Number.POSITIVE_INFINITY)).toBe(0);
    expect(listAuditLog(db)).toHaveLength(1);
  });

  it("accepts the Drizzle wrapper and touches only audit_log", () => {
    const db = getDb();
    const raw = getRawDb();
    // A non-audit row that must survive the prune.
    raw.prepare("INSERT INTO houses (id,name,description,kind,status) VALUES ('keep','Keep','','agent','active')").run();
    recordAudit(db, { id: "old", action: "create", entityType: "house", entityId: "h1" });
    raw.prepare("UPDATE audit_log SET created_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "old");

    expect(pruneAuditLog(db, 7)).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM houses").get()).toEqual({ n: 1 });
  });
});

describe("toAuditCsv (RFC-4180 serializer)", () => {
  function dto(overrides: Partial<AuditLogDto> = {}): AuditLogDto {
    return {
      id: "a1",
      actor: "user",
      actorAgentId: null,
      action: "create",
      entityType: "house",
      entityId: "h1",
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("emits the documented header order with CRLF row endings", () => {
    const csv = toAuditCsv([dto()]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(AUDIT_CSV_HEADER.join(","));
    expect(csv.endsWith("\r\n")).toBe(true);
    // No bare LF anywhere (every row is CRLF-terminated).
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("quotes + escapes comma, double-quote and newline fields per RFC-4180", () => {
    // entityId carries a comma, a double-quote and an LF — the serializer must
    // quote it, double the embedded quote and preserve the newline.
    const csv = toAuditCsv([dto({ id: "a2", entityId: 'x,"y\nz' })]);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine).toBe('a2,user,,create,house,"x,""y\nz",{},2026-01-01T00:00:00.000Z');
    // The quote/escape rule fires specifically because of `,`, `"` and LF.
    expect(csv).toContain('"x,""y\nz"');
  });

  it("quotes the metadata JSON field whenever it contains a comma", () => {
    const csv = toAuditCsv([dto({ metadata: { note: "a,b" } })]);
    const dataLine = csv.split("\r\n")[1];
    // JSON.stringify({note:"a,b"}) = {"note":"a,b"} → quoted + doubled.
    expect(dataLine).toContain('"{""note"":""a,b""}"');
  });

  it("doubles embedded double-quotes in a plain field", () => {
    const csv = toAuditCsv([dto({ id: 'a"b' })]);
    expect(csv.split("\r\n")[1].startsWith('"a""b",user,')).toBe(true);
  });

  it("does not quote fields without reserved characters", () => {
    const csv = toAuditCsv([dto({ id: "plain", action: "update" })]);
    expect(csv.split("\r\n")[1]).toContain("plain,user,,update,house,h1,{},");
  });
});

