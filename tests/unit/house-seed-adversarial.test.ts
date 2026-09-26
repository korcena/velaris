/**
 * ADVERSARIAL unit tests — default ACOTAR houses (independent of the author's).
 *
 * Focus: data safety. Probes cleanup destructiveness, no-clobber edge cases,
 * idempotency/concurrency across connections, roster fidelity vs the approved
 * spec §3/§4, and derivation round-trip.
 *
 * Isolation contract: temp `VELARIS_DB_PATH` (never db/velaris.db), migrate per
 * test; resetDbForTests() in beforeEach/afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { bootstrapDb, resetBootstrapForTests } from "@/server/bootstrap";
import {
  seedDefaultHouses,
  seedHighLordHouse,
  listHouses,
  getHouse,
  createHouse,
  transitionHouseStatus,
} from "@/server/repositories/house-repo";
import {
  seedDefaultTemplates,
  createTemplate,
  getTemplate,
  listTemplates,
  findTemplateByName,
} from "@/server/repositories/template-repo";
import { instantiateHouseTemplate } from "@/server/services/template-service";
import {
  DEFAULT_HOUSES,
  DEFAULT_TEMPLATES,
} from "@/shared/constants";
import {
  houseTemplatePayloadSchema,
  projectTemplatePayloadSchema,
} from "@/shared/schemas/template";
import type { HouseConfiguration, HouseTemplatePayload } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-defadv-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A minimal but schema-valid house template payload. */
function validHousePayload(): HouseTemplatePayload {
  return {
    description: "adversarial payload",
    agent: { name: "Tester", role: "Tester · adversarial" },
    configuration: {
      systemPrompt: "You are a test agent.",
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "some-model",
      workspaceAllowlist: [],
      tools: ["fs"],
      permissions: { fileSystem: "ask", shell: "deny", network: "deny", git: "deny" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  };
}

function openSecondConnection(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

/* ================================================================== */
/* 1. Cleanup destructiveness                                         */
/* ================================================================== */

describe("ADVERSARIAL cleanup: what it must never delete", () => {
  it("does NOT delete a user (is_seeded=0) house template named exactly like a default", () => {
    const db = getDb();
    const user = createTemplate(db, {
      kind: "house",
      name: "Day Court",
      description: "mine",
      payload: validHousePayload(),
      isSeeded: false,
    });

    const inserted = seedDefaultTemplates(db);

    // The user row survives and blocks the seeded insert.
    expect(getTemplate(db, user.id)).toBeTruthy();
    expect(findTemplateByName(db, "house", "Day Court")!.isSeeded).toBe(false);
    expect(findTemplateByName(db, "house", "Day Court")!.description).toBe("mine");
    expect(inserted).toBe(DEFAULT_TEMPLATES.length - 1);
  });

  it("deletes a SEEDED 'day court' (lowercase) but keeps the default 'Day Court'", () => {
    const db = getDb();
    getRawDb()
      .prepare(
        `INSERT INTO templates (id, kind, name, description, payload, is_seeded, created_at, updated_at)
         VALUES ('lower-case-seed','house','day court','stale',?,1,?,?)`,
      )
      .run(JSON.stringify(validHousePayload()), new Date().toISOString(), new Date().toISOString());

    seedDefaultTemplates(db);

    // SQLite NOT IN is binary/case-sensitive: 'day court' is not in the default
    // set, so the stale seeded row is removed. (This is the documented key.)
    expect(findTemplateByName(db, "house", "day court")).toBeNull();
    expect(findTemplateByName(db, "house", "Day Court")!.isSeeded).toBe(true);
  });

  it("deletes a SEEDED name differing only by trailing whitespace", () => {
    const db = getDb();
    getRawDb()
      .prepare(
        `INSERT INTO templates (id, kind, name, description, payload, is_seeded, created_at, updated_at)
         VALUES ('space-seed','house','Day Court ','stale',?,1,?,?)`,
      )
      .run(JSON.stringify(validHousePayload()), new Date().toISOString(), new Date().toISOString());

    seedDefaultTemplates(db);

    expect(findTemplateByName(db, "house", "Day Court ")).toBeNull();
    expect(findTemplateByName(db, "house", "Day Court")!.isSeeded).toBe(true);
  });

  it("never touches the seeded project template, even while deleting seeded houses", () => {
    const db = getDb();
    getRawDb()
      .prepare(
        `INSERT INTO templates (id, kind, name, description, payload, is_seeded, created_at, updated_at)
         VALUES ('legacy-house','house','Legacy Court','stale',?,1,?,?)`,
      )
      .run(JSON.stringify(validHousePayload()), new Date().toISOString(), new Date().toISOString());
    const userProject = createTemplate(db, {
      kind: "project",
      name: "My Project",
      payload: { description: "mine", defaultModel: null, instructions: null },
    });

    seedDefaultTemplates(db);

    expect(findTemplateByName(db, "house", "Legacy Court")).toBeNull();
    expect(findTemplateByName(db, "project", "Standard Repo")).toBeTruthy();
    expect(getTemplate(db, userProject.id)).toBeTruthy();
  });

  it("survives a user template named EXACTLY like a superseded seed (is_seeded=0)", () => {
    const db = getDb();
    // User owns a template literally called "Research House" (not seeded).
    const userResearch = createTemplate(db, {
      kind: "house",
      name: "Research House",
      description: "user's own",
      payload: validHousePayload(),
    });
    // And a stale SEEDED row with the same name cannot coexist (unique index);
    // so insert the seeded one under a name that is absent from defaults.
    getRawDb()
      .prepare(
        `INSERT INTO templates (id, kind, name, description, payload, is_seeded, created_at, updated_at)
         VALUES ('stale-seed','house','Engineering House','stale',?,1,?,?)`,
      )
      .run(JSON.stringify(validHousePayload()), new Date().toISOString(), new Date().toISOString());

    seedDefaultTemplates(db);

    // The user's "Research House" (is_seeded=0) survives even though the name is
    // absent from the default set — cleanup is keyed on is_seeded=1.
    expect(getTemplate(db, userResearch.id)).toBeTruthy();
    expect(findTemplateByName(db, "house", "Research House")!.isSeeded).toBe(false);
    // The stale seeded row with a superseded name is removed.
    expect(findTemplateByName(db, "house", "Engineering House")).toBeNull();
  });

  it("removes a seeded template for a house the user deleted from DEFAULT_HOUSES (superseded)", () => {
    const db = getDb();
    getRawDb()
      .prepare(
        `INSERT INTO templates (id, kind, name, description, payload, is_seeded, created_at, updated_at)
         VALUES ('docs-house','house','Docs House','superseded',?,1,?,?)`,
      )
      .run(JSON.stringify(validHousePayload()), new Date().toISOString(), new Date().toISOString());

    expect(seedDefaultTemplates(db)).toBe(DEFAULT_TEMPLATES.length);
    expect(findTemplateByName(db, "house", "Docs House")).toBeNull();
  });
});

/* ================================================================== */
/* 2. No-clobber correctness                                          */
/* ================================================================== */

describe("ADVERSARIAL no-clobber", () => {
  it("skips a same-named ARCHIVED house with a different configuration", () => {
    const db = getDb();
    const archived = createHouse(db, {
      name: "Day Court",
      description: "user's archived house",
      agent: { name: "NotHelion", role: "custom" },
      configuration: {
        systemPrompt: "custom",
        executionProvider: "ollama",
        aiProvider: "ollama",
        modelId: "custom-model",
        workspaceAllowlist: [],
        tools: ["fs"],
        permissions: { fileSystem: "ask", shell: "deny", network: "deny", git: "deny" },
        approvalPolicy: "always",
        concurrency: 2,
      },
    });
    transitionHouseStatus(db, archived.id, "disabled");
    transitionHouseStatus(db, archived.id, "archived");

    expect(seedDefaultHouses(db)).toBe(9);
    const after = getHouse(db, archived.id)!;
    expect(after.status).toBe("archived");
    expect(after.agent.name).toBe("NotHelion");
    expect(after.configuration.modelId).toBe("custom-model");
    // Exactly one "Day Court" row overall.
    const rows = getRawDb()
      .prepare("SELECT COUNT(*) c FROM houses WHERE name = 'Day Court'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it("skips a same-named kind='high_lord' house (any kind blocks, per resolved Q5)", () => {
    const db = getDb();
    // Raw insert a high_lord house that claims the default name (no agent needed).
    getRawDb()
      .prepare(
        `INSERT INTO houses (id, name, description, kind, status, created_at, updated_at)
         VALUES ('hl-day','Day Court','impostor','high_lord','active',?,?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());

    expect(seedDefaultHouses(db)).toBe(9);
    const row = getRawDb()
      .prepare("SELECT kind FROM houses WHERE name = 'Day Court'")
      .get() as { kind: string };
    expect(row.kind).toBe("high_lord");
  });

  it("treats a case-only difference as ABSENT → creates a second, differently-cased house", () => {
    const db = getDb();
    createHouse(db, {
      name: "day court",
      description: "lowercase user house",
      agent: { name: "lower", role: "r" },
      configuration: {
        systemPrompt: "custom",
        executionProvider: "opencode",
        aiProvider: "ollama-cloud",
        modelId: "m",
        workspaceAllowlist: [],
        tools: ["fs"],
        permissions: { fileSystem: "ask", shell: "deny", network: "deny", git: "deny" },
        approvalPolicy: "always",
        concurrency: 1,
      },
    });

    // Exact matching means "Day Court" is considered absent and is inserted.
    expect(seedDefaultHouses(db)).toBe(10);
    const names = getRawDb()
      .prepare("SELECT name FROM houses WHERE lower(name) = 'day court' ORDER BY name")
      .all() as { name: string }[];
    // Documented consequence: two houses that look like duplicates.
    expect(names.map((n) => n.name)).toEqual(["Day Court", "day court"]);
  });

  it("treats a trailing-space name as ABSENT → creates a duplicate-looking house", () => {
    const db = getDb();
    getRawDb()
      .prepare(
        `INSERT INTO houses (id, name, description, kind, status, created_at, updated_at)
         VALUES ('spacey','Day Court ','user','agent','active',?,?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());

    expect(seedDefaultHouses(db)).toBe(10);
    const rows = getRawDb()
      .prepare("SELECT name FROM houses WHERE name LIKE 'Day Court%' ORDER BY name")
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["Day Court", "Day Court "]);
  });

  it("RE-CREATES a default when a user RENAMES the seeded house (name-based guard gap)", () => {
    const db = getDb();
    seedDefaultHouses(db);
    const day = listHouses(db).find((h) => h.name === "Day Court")!;
    // A user renames the seeded house (a legal edit through the standard form).
    const edited = getHouse(db, day.id)!;
    getRawDb().prepare("UPDATE houses SET name = 'My Day Court' WHERE id = ?").run(day.id);

    // Next boot: 'Day Court' now looks absent, so the seeder recreates it,
    // leaving the user with BOTH houses.
    expect(seedDefaultHouses(db)).toBe(1);
    const names = getRawDb()
      .prepare("SELECT name FROM houses WHERE name IN ('Day Court','My Day Court') ORDER BY name")
      .all() as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(["Day Court", "My Day Court"]);
    // The renamed house's edits still survive (id unchanged).
    expect(getHouse(db, edited.id)!.agent.name).toBe(day.agent.name);
  });

  it("leaves an edited seed house's agent + config untouched on re-seed (no audit writes)", () => {
    const db = getDb();
    seedDefaultHouses(db);
    const day = listHouses(db).find((h) => h.name === "Day Court")!;
    // Direct repo update: change every sensitive field.
    const updated = getHouse(db, day.id)!;
    getRawDb()
      .prepare("UPDATE agents SET name = 'Edited' WHERE house_id = ?")
      .run(day.id);
    getRawDb()
      .prepare("UPDATE agent_configurations SET model_id = 'edited-model', concurrency = 3 WHERE agent_id = ?")
      .run(updated.agents[0].id);

    seedDefaultHouses(db);
    const after = getHouse(db, day.id)!;
    expect(after.agent.name).toBe("Edited");
    expect(after.configuration.modelId).toBe("edited-model");
    expect(after.configuration.concurrency).toBe(3);
  });
});

/* ================================================================== */
/* 3. Idempotency & concurrency                                       */
/* ================================================================== */

describe("ADVERSARIAL idempotency & concurrency", () => {
  it("two separate raw connections cannot double-insert", () => {
    const a = openSecondConnection();
    const b = openSecondConnection();
    try {
      expect(seedDefaultHouses(a)).toBe(10);
      expect(seedDefaultHouses(b)).toBe(0);
    } finally {
      a.close();
      b.close();
    }
    const rows = getRawDb().prepare("SELECT COUNT(*) c FROM houses").get() as { c: number };
    expect(rows.c).toBe(10);
  });

  /**
   * REGRESSION (plan §8/Q6): `seedDefaultTemplates` must hold an `.immediate()`
   * write transaction across its check+insert, so a concurrent writer cannot
   * slip in between B's existence check and B's insert.
   *
   * Deterministic probe: while connection B is executing its first INSERT, a
   * second connection A (busy_timeout=0) attempts a raw write. If B holds the
   * write lock (fix present) A raises SQLITE_BUSY immediately. If B were
   * un-transacted (the original defect) A's write would succeed, proving there
   * was a window between check and insert. The earlier 2-process harness
   * reproduced the original UNIQUE-constraint crash 15/15; this locks the fix
   * in without depending on scheduling.
   */
  it("REGRESSION: template seed holds an immediate write lock across check+insert", () => {
    const a = openSecondConnection();
    a.pragma("busy_timeout = 0");
    const b = openSecondConnection();
    let probed: boolean | null = null;
    let sawInsert = false;

    try {
      const patched = new Proxy(b, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              const stmt = target.prepare(sql);
              if (!sql.includes("INSERT INTO templates")) return stmt;
              return new Proxy(stmt, {
                get(st, p) {
                  if (p !== "run") return (st as unknown as Record<string | symbol, unknown>)[p];
                  return (...args: unknown[]) => {
                    if (sawInsert) return (st as unknown as { run: (...a: unknown[]) => unknown }).run(...args);
                    sawInsert = true;
                    try {
                      a.prepare(
                        `INSERT INTO templates (id, kind, name, description, payload, is_seeded, created_at, updated_at)
                         VALUES ('probe','house','Probe Court','p','{}',1,'x','x')`,
                      ).run();
                      probed = false; // A's write got through → B held no lock.
                    } catch (e) {
                      probed = (e as Error).message.includes("locked");
                    }
                    return (st as unknown as { run: (...a: unknown[]) => unknown }).run(...args);
                  };
                },
              });
            };
          }
          return (target as unknown as Record<string | symbol, unknown>)[prop];
        },
      });

      const inserted = seedDefaultTemplates(patched as unknown as Database.Database);
      expect(inserted).toBe(DEFAULT_TEMPLATES.length);
      // The lock must have been observed (probe ran) and must have BLOCKED A.
      expect(probed).toBe(true);
      // A never got its probe row in.
      expect(findTemplateByName(getDb(), "house", "Probe Court")).toBeNull();
    } finally {
      a.close();
      b.close();
    }
  });

  /**
   * REGRESSION (same class as the template-seed Q6 fix): `seedHighLordHouse`
   * must hold an `.immediate()` write transaction across its check+insert, so
   * concurrent web + engine first boots cannot both see "no High Lord" and each
   * insert one. Probe is identical to the template test above: while B runs its
   * first INSERT, A (busy_timeout=0) attempts a raw write; with the fix B holds
   * the lock and A is refused immediately.
   */
  it("REGRESSION: High Lord seed holds an immediate write lock across check+insert", () => {
    const a = openSecondConnection();
    a.pragma("busy_timeout = 0");
    const b = openSecondConnection();
    let probed: boolean | null = null;
    let sawInsert = false;

    try {
      const patched = new Proxy(b, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              const stmt = target.prepare(sql);
              if (!sql.includes("INSERT INTO houses")) return stmt;
              return new Proxy(stmt, {
                get(st, p) {
                  if (p !== "run") return (st as unknown as Record<string | symbol, unknown>)[p];
                  return (...args: unknown[]) => {
                    if (sawInsert) return (st as unknown as { run: (...a: unknown[]) => unknown }).run(...args);
                    sawInsert = true;
                    try {
                      a.prepare(
                        `INSERT INTO houses (id, name, description, kind, status, created_at, updated_at)
                         VALUES ('probe-hl','Probe Court','p','agent','active','x','x')`,
                      ).run();
                      probed = false; // A's write got through → B held no lock.
                    } catch (e) {
                      probed = (e as Error).message.includes("locked");
                    }
                    return (st as unknown as { run: (...a: unknown[]) => unknown }).run(...args);
                  };
                },
              });
            };
          }
          return (target as unknown as Record<string | symbol, unknown>)[prop];
        },
      });

      seedHighLordHouse(patched as unknown as Database.Database);
      // The lock must have been observed (probe ran) and must have BLOCKED A.
      expect(probed).toBe(true);
      // A never got its probe row in, and exactly one High Lord exists.
      const count = getRawDb()
        .prepare("SELECT COUNT(*) c FROM houses WHERE kind='high_lord'")
        .get() as { c: number };
      expect(count.c).toBe(1);
      const probe = getRawDb()
        .prepare("SELECT COUNT(*) c FROM houses WHERE id='probe-hl'")
        .get() as { c: number };
      expect(probe.c).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });

  it("two separate raw connections seed exactly one High Lord", () => {
    const a = openSecondConnection();
    const b = openSecondConnection();
    try {
      seedHighLordHouse(a);
      seedHighLordHouse(b);
    } finally {
      a.close();
      b.close();
    }
    const count = getRawDb()
      .prepare("SELECT COUNT(*) c FROM houses WHERE kind='high_lord'")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("keeps houses/agents/configs counts in lockstep (transaction integrity)", () => {
    const db = getDb();
    seedDefaultHouses(db);
    const raw = getRawDb();
    const houses = raw.prepare("SELECT COUNT(*) c FROM houses").get() as { c: number };
    const agents = raw.prepare("SELECT COUNT(*) c FROM agents").get() as { c: number };
    const configs = raw.prepare("SELECT COUNT(*) c FROM agent_configurations").get() as { c: number };
    expect(houses.c).toBe(10);
    expect(agents.c).toBe(10);
    expect(configs.c).toBe(10);
    // And no agent/config is orphaned.
    const orphanAgents = raw
      .prepare("SELECT COUNT(*) c FROM agents a LEFT JOIN houses h ON h.id=a.house_id WHERE h.id IS NULL")
      .get() as { c: number };
    const orphanConfigs = raw
      .prepare(
        "SELECT COUNT(*) c FROM agent_configurations c LEFT JOIN agents a ON a.id=c.agent_id WHERE a.id IS NULL",
      )
      .get() as { c: number };
    expect(orphanAgents.c).toBe(0);
    expect(orphanConfigs.c).toBe(0);
  });

  it("works in either seed order (templates→houses and houses→templates)", () => {
    // Order A: templates first, then houses.
    expect(seedDefaultTemplates(getDb())).toBe(DEFAULT_TEMPLATES.length);
    expect(seedDefaultHouses(getDb())).toBe(10);
    expect(listTemplates(getDb()).length).toBe(DEFAULT_TEMPLATES.length);

    // Fresh DB for order B (new file so order-A rows do not persist).
    resetDbForTests();
    dbPath = path.join(tmpDir, "test-order-b.db");
    process.env.VELARIS_DB_PATH = dbPath;
    migrate();
    resetBootstrapForTests();
    expect(seedDefaultHouses(getDb())).toBe(10);
    expect(seedDefaultTemplates(getDb())).toBe(DEFAULT_TEMPLATES.length);
    expect(listHouses(getDb())).toHaveLength(10);
  });

  it("bootstrapDb twice seeds 10 houses + 11 templates and is a no-op the second time", () => {
    bootstrapDb();
    bootstrapDb(); // guarded by _done
    const db = getDb();
    expect(listHouses(db, { includeArchived: true })).toHaveLength(10);
    expect(listTemplates(db)).toHaveLength(DEFAULT_TEMPLATES.length);
    // High Lord also present but excluded from listHouses default.
    expect(listHouses(db, { includeHighLord: true })).toHaveLength(11);
  });

  it("re-seeding templates from a second connection is safe and keeps user rows", () => {
    const db = getDb();
    seedDefaultTemplates(db);
    const user = createTemplate(db, {
      kind: "house",
      name: "Entirely Mine",
      payload: validHousePayload(),
    });
    const b = openSecondConnection();
    try {
      expect(seedDefaultTemplates(b)).toBe(0); // already present
    } finally {
      b.close();
    }
    expect(getTemplate(db, user.id)).toBeTruthy();
    expect(findTemplateByName(db, "house", "Entirely Mine")!.isSeeded).toBe(false);
  });
});

/* ================================================================== */
/* 4. Roster fidelity vs the approved spec (§3/§4)                    */
/* ================================================================== */

describe("ADVERSARIAL roster fidelity", () => {
  // Independent transcription of the frozen spec tables.
  const SPEC = [
    { name: "Day Court", agent: "Helion", role: "Spell-cleaver · software developer", tools: ["fs", "shell", "git"], perm: { fileSystem: "ask", shell: "ask", network: "ask", git: "allow" }, approval: "risky_only" },
    { name: "House of Shadow", agent: "Azriel", role: "Shadowsinger · software tester", tools: ["fs", "shell", "git"], perm: { fileSystem: "ask", shell: "ask", network: "ask", git: "allow" }, approval: "risky_only" },
    { name: "Hewn City", agent: "Amren", role: "The Second · software reviewer", tools: ["fs", "shell", "git"], perm: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" }, approval: "always" },
    { name: "The Library", agent: "Clotho", role: "High Priestess of the Library · technical writer", tools: ["fs", "git"], perm: { fileSystem: "ask", shell: "deny", network: "deny", git: "allow" }, approval: "always" },
    { name: "Court of Truth", agent: "Morrigan", role: "Truth-bearer · analyst", tools: ["fs"], perm: { fileSystem: "ask", shell: "deny", network: "ask", git: "deny" }, approval: "always" },
    { name: "The Townhouse", agent: "Nuala", role: "Keeper of the House · secretary", tools: ["fs", "git"], perm: { fileSystem: "ask", shell: "deny", network: "ask", git: "allow" }, approval: "always" },
    { name: "Summer Court", agent: "Tarquin", role: "High Lord of Summer · accountant", tools: ["fs"], perm: { fileSystem: "ask", shell: "deny", network: "deny", git: "deny" }, approval: "always" },
    { name: "Windhaven", agent: "Gwyn", role: "Valkyrie archivist · researcher", tools: ["fs"], perm: { fileSystem: "ask", shell: "deny", network: "ask", git: "deny" }, approval: "always" },
    { name: "The Crossing", agent: "Lucien", role: "Emissary · liaison", tools: ["fs"], perm: { fileSystem: "ask", shell: "deny", network: "ask", git: "deny" }, approval: "always" },
    { name: "Illyria", agent: "Cassian", role: "General of the Armies · operations lead", tools: ["fs", "shell", "git"], perm: { fileSystem: "ask", shell: "ask", network: "ask", git: "allow" }, approval: "risky_only" },
  ] as const;

  it("matches the spec's order, names, agents, roles, tools, permissions, approval", () => {
    expect(DEFAULT_HOUSES).toHaveLength(SPEC.length);
    SPEC.forEach((s, i) => {
      const h = DEFAULT_HOUSES[i];
      expect(h.house.name).toBe(s.name);
      expect(h.agent.name).toBe(s.agent);
      expect(h.agent.role).toBe(s.role);
      expect(h.configuration.tools).toEqual(s.tools);
      expect(h.configuration.permissions).toEqual(s.perm);
      expect(h.configuration.approvalPolicy).toBe(s.approval);
    });
  });

  it("uses opencode/ollama-cloud/deepseek-v4.1-flash, [] allowlist, concurrency 1 everywhere", () => {
    for (const h of DEFAULT_HOUSES) {
      expect(h.configuration.executionProvider).toBe("opencode");
      expect(h.configuration.aiProvider).toBe("ollama-cloud");
      expect(h.configuration.modelId).toBe("deepseek-v4.1-flash");
      expect(h.configuration.workspaceAllowlist).toEqual([]);
      expect(h.configuration.concurrency).toBe(1);
    }
  });

  it("has 10 distinct non-empty descriptions and systemPrompts, each naming its character", () => {
    const descriptions = DEFAULT_HOUSES.map((h) => h.house.description);
    const prompts = DEFAULT_HOUSES.map((h) => h.configuration.systemPrompt);
    expect(new Set(descriptions).size).toBe(10);
    expect(new Set(prompts).size).toBe(10);
    for (const h of DEFAULT_HOUSES) {
      expect(h.house.description.trim().length).toBeGreaterThan(0);
      expect(h.configuration.systemPrompt.trim().length).toBeGreaterThan(0);
      expect(h.configuration.systemPrompt).toContain(h.agent.name);
    }
  });

  it("seeds exactly the spec roster into the DB with the exact configuration", () => {
    const db = getDb();
    seedDefaultHouses(db);
    for (const s of SPEC) {
      const house = listHouses(db).find((h) => h.name === s.name)!;
      expect(house.agent.name).toBe(s.agent);
      expect(house.configuration.tools).toEqual(s.tools);
      expect(house.configuration.permissions).toEqual(s.perm);
    }
  });
});

/* ================================================================== */
/* 5. Derivation parity + strict-schema round-trip                    */
/* ================================================================== */

describe("ADVERSARIAL derivation parity & instantiation round-trip", () => {
  it("DEFAULT_TEMPLATES = 10 derived house templates + Standard Repo, one-for-one", () => {
    const houseTpls = DEFAULT_TEMPLATES.filter((t) => t.kind === "house");
    expect(houseTpls).toHaveLength(DEFAULT_HOUSES.length);
    expect(DEFAULT_TEMPLATES.filter((t) => t.kind === "project").map((t) => t.name)).toEqual([
      "Standard Repo",
    ]);
    DEFAULT_HOUSES.forEach((h) => {
      const t = houseTpls.find((x) => x.name === h.house.name)!;
      expect(t).toBeTruthy();
      expect(t.description).toBe(h.house.description);
      expect(t.payload).toEqual({
        description: h.house.description,
        agent: { name: h.agent.name, role: h.agent.role },
        configuration: h.configuration,
      });
    });
  });

  it("every default house template instantiates a fully configured, matching house", () => {
    const db = getDb();
    seedDefaultTemplates(db);
    for (const h of DEFAULT_HOUSES) {
      const tpl = findTemplateByName(db, "house", h.house.name)!;
      expect(tpl).toBeTruthy();
      const house = instantiateHouseTemplate(db, tpl.id, {
        name: `RT ${h.house.name}`,
      });
      expect(house.name).toBe(`RT ${h.house.name}`);
      expect(house.agent.name).toBe(h.agent.name);
      expect(house.agent.role).toBe(h.agent.role);
      expect(house.configuration).toEqual<HouseConfiguration>(h.configuration);
      expect(house.kind).toBe("agent");
      expect(house.status).toBe("active");
      expect(house.agents).toHaveLength(1);
    }
  });

  it("rejects wrong-kind payloads by construction (strict schema)", () => {
    // A house payload must not parse as a project payload and vice versa.
    expect(() => projectTemplatePayloadSchema.parse(validHousePayload())).toThrow();
    expect(() =>
      houseTemplatePayloadSchema.parse({
        description: "repo",
        defaultModel: "glm-5.3",
        instructions: "x",
      }),
    ).toThrow();
    // Every derived house payload parses (strict) with exactly three keys.
    for (const t of DEFAULT_TEMPLATES) {
      if (t.kind !== "house") continue;
      const parsed = houseTemplatePayloadSchema.parse(t.payload);
      expect(Object.keys(parsed).sort()).toEqual(["agent", "configuration", "description"]);
    }
  });

  it("seedDefaultHouses and derived templates carry byte-identical configuration JSON", () => {
    const db = getDb();
    seedDefaultHouses(db);
    const raw = getRawDb();
    for (const h of DEFAULT_HOUSES) {
      const row = raw
        .prepare(
          `SELECT c.tools, c.permissions, c.system_prompt, c.execution_provider, c.ai_provider, c.model_id, c.approval_policy, c.concurrency, c.workspace_allowlist
           FROM houses h JOIN agents a ON a.house_id=h.id
           JOIN agent_configurations c ON c.agent_id=a.id
           WHERE h.name = ?`,
        )
        .get(h.house.name) as {
        tools: string;
        permissions: string;
        system_prompt: string;
        execution_provider: string;
        ai_provider: string;
        model_id: string;
        approval_policy: string;
        concurrency: number;
        workspace_allowlist: string;
      };
      expect(row.tools).toBe(JSON.stringify(h.configuration.tools));
      expect(row.permissions).toBe(JSON.stringify(h.configuration.permissions));
      expect(row.workspace_allowlist).toBe(JSON.stringify(h.configuration.workspaceAllowlist));
      expect(row.system_prompt).toBe(h.configuration.systemPrompt);
      expect(row.execution_provider).toBe("opencode");
      expect(row.ai_provider).toBe("ollama-cloud");
      expect(row.model_id).toBe("deepseek-v4.1-flash");
      expect(row.approval_policy).toBe(h.configuration.approvalPolicy);
      expect(row.concurrency).toBe(1);
    }
  });
});

/* ================================================================== */
/* 6. High Lord / user data untouched                                 */
/* ================================================================== */

describe("ADVERSARIAL High Lord isolation", () => {
  it("seeding defaults leaves the High Lord singleton and its config untouched", () => {
    const db = getDb();
    seedHighLordHouse(db);
    const before = listHouses(db, { includeHighLord: true }).find((h) => h.kind === "high_lord")!;
    expect(seedDefaultHouses(db)).toBe(10);
    const after = listHouses(db, { includeHighLord: true }).find((h) => h.kind === "high_lord")!;
    expect(after.id).toBe(before.id);
    expect(after.agent.name).toBe(before.agent.name);
    expect(after.configuration).toEqual(before.configuration);
    // Exactly one high_lord row.
    const count = getRawDb()
      .prepare("SELECT COUNT(*) c FROM houses WHERE kind='high_lord'")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });
});
