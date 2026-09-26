/**
 * Unit tests — template repository + service (Phase 6 Stage C).
 *
 * Temp DB per test (migrate → run → teardown), mirroring house-agents.test.ts.
 * Covers: CRUD, JSON payload round-trip, idempotent seed, no-clobber, seeded
 * immutability, and instantiation mapping to a fully configured house/project
 * (the §10 acceptance criterion) incl. directory validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  deleteTemplate,
  seedDefaultTemplates,
  findTemplateByName,
  SeededTemplateError,
  TemplateNotFoundError,
  TemplateNameExistsError,
} from "@/server/repositories/template-repo";
import {
  createTemplateService,
  updateTemplateService,
  deleteTemplateService,
  instantiateHouseTemplate,
  instantiateProjectTemplate,
  TemplateKindMismatchError,
} from "@/server/services/template-service";
import { listHouses, getHouse } from "@/server/repositories/house-repo";
import { listProjects } from "@/server/repositories/project-repo";
import { listAuditLog } from "@/server/repositories/audit-repo";
import { DEFAULT_TEMPLATES, DEFAULT_HOUSES } from "@/shared/constants";
import { houseTemplatePayloadSchema } from "@/shared/schemas/template";
import type { HouseTemplatePayload, ProjectTemplatePayload } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

function housePayload(over: Partial<HouseTemplatePayload> = {}): HouseTemplatePayload {
  return {
    description: "A test house template",
    agent: { name: "Templar", role: "Knight · engineer" },
    configuration: {
      systemPrompt: "You are a templar.",
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "glm-5.3",
      workspaceAllowlist: [tmpDir],
      tools: ["fs", "git"],
      permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
      approvalPolicy: "always",
      concurrency: 1,
    },
    ...over,
  };
}

function projectPayload(over: Partial<ProjectTemplatePayload> = {}): ProjectTemplatePayload {
  return {
    description: "A repo project",
    defaultModel: "glm-5.3",
    instructions: "Read conventions first.",
    ...over,
  };
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-template-"));
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
/* CRUD + payload round-trip                                          */
/* ================================================================== */

describe("template repository CRUD", () => {
  it("creates a house template and round-trips its JSON payload", () => {
    const db = getDb();
    const t = createTemplate(db, {
      kind: "house",
      name: "Test House",
      description: "desc",
      payload: housePayload(),
    });

    expect(t.id).toBeTruthy();
    expect(t.kind).toBe("house");
    expect(t.isSeeded).toBe(false);

    const loaded = getTemplate(db, t.id)!;
    const payload = loaded.payload as HouseTemplatePayload;
    expect(payload.agent).toEqual({ name: "Templar", role: "Knight · engineer" });
    expect(payload.configuration.modelId).toBe("glm-5.3");
    expect(payload.configuration.workspaceAllowlist).toEqual([tmpDir]);
    expect(payload.configuration.tools).toEqual(["fs", "git"]);
    expect(payload.configuration.permissions.git).toBe("allow");
  });

  it("creates a project template and round-trips its JSON payload", () => {
    const db = getDb();
    const t = createTemplate(db, {
      kind: "project",
      name: "Test Repo",
      payload: projectPayload(),
    });
    const loaded = getTemplate(db, t.id)!;
    const payload = loaded.payload as ProjectTemplatePayload;
    expect(payload.defaultModel).toBe("glm-5.3");
    expect(payload.instructions).toBe("Read conventions first.");
  });

  it("lists by kind, seeded-first then newest-first", () => {
    const db = getDb();
    seedDefaultTemplates(db);
    createTemplate(db, { kind: "house", name: "User House", payload: housePayload() });
    createTemplate(db, { kind: "project", name: "User Repo", payload: projectPayload() });

    const houses = listTemplates(db, { kind: "house" });
    expect(houses.some((t) => t.name === "User House")).toBe(true);
    expect(houses[0].isSeeded).toBe(true);
    // Project kind filter excludes house templates.
    const projects = listTemplates(db, { kind: "project" });
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.every((t) => t.kind === "project")).toBe(true);
  });

  it("update merges fields and rejects unknown id", () => {
    const db = getDb();
    const t = createTemplate(db, { kind: "house", name: "Old", payload: housePayload() });
    const updated = updateTemplate(db, t.id, { name: "New", description: "changed" });
    expect(updated.name).toBe("New");
    expect(updated.description).toBe("changed");
    expect((updated.payload as HouseTemplatePayload).agent.name).toBe("Templar");

    expect(() => updateTemplate(db, "missing", { name: "X" })).toThrow(TemplateNotFoundError);
  });

  it("delete removes a user template; unknown id throws", () => {
    const db = getDb();
    const t = createTemplate(db, { kind: "house", name: "Gone", payload: housePayload() });
    deleteTemplate(db, t.id);
    expect(getTemplate(db, t.id)).toBeNull();
    expect(() => deleteTemplate(db, "missing")).toThrow(TemplateNotFoundError);
  });

  it("rejects a duplicate (kind, name) — unique per kind only", () => {
    const db = getDb();
    createTemplate(db, { kind: "house", name: "Dup", payload: housePayload() });
    expect(() =>
      createTemplate(db, { kind: "house", name: "Dup", payload: housePayload() }),
    ).toThrow(TemplateNameExistsError);
    // Same name under a different kind is allowed.
    expect(() =>
      createTemplate(db, { kind: "project", name: "Dup", payload: projectPayload() }),
    ).not.toThrow();
  });
});

/* ================================================================== */
/* Seeding                                                            */
/* ================================================================== */

describe("seedDefaultTemplates", () => {
  it("inserts the seeded defaults once and is idempotent", () => {
    const db = getDb();
    const first = seedDefaultTemplates(db);
    expect(first).toBe(DEFAULT_TEMPLATES.length);
    const second = seedDefaultTemplates(db);
    expect(second).toBe(0);

    const all = listTemplates(db);
    expect(all).toHaveLength(DEFAULT_TEMPLATES.length);
    expect(all.every((t) => t.isSeeded)).toBe(true);
    expect(all.map((t) => t.name).sort()).toEqual(
      DEFAULT_TEMPLATES.map((t) => t.name).sort(),
    );
  });

  it("does NOT clobber a user edit to an identically named row", () => {
    const db = getDb();
    const t = createTemplate(db, {
      kind: "house",
      name: "Day Court",
      description: "my custom version",
      payload: housePayload({ description: "custom" }),
    });
    // Re-seeding must skip the existing (kind,name) entirely.
    const inserted = seedDefaultTemplates(db);
    const still = getTemplate(db, t.id)!;
    expect(still.description).toBe("my custom version");
    expect((still.payload as HouseTemplatePayload).description).toBe("custom");
    // No duplicate row was created for "Day Court".
    expect(listTemplates(db, { kind: "house" }).filter((x) => x.name === "Day Court")).toHaveLength(1);
    // The user row (is_seeded=0) is never deleted by cleanup either.
    expect(still.isSeeded).toBe(false);
    // Other defaults are still inserted.
    expect(inserted).toBe(DEFAULT_TEMPLATES.length - 1);
  });

  it("findTemplateByName locates a seeded default by (kind,name)", () => {
    const db = getDb();
    seedDefaultTemplates(db);
    const t = findTemplateByName(db, "project", "Standard Repo");
    expect(t).toBeTruthy();
    expect(t!.isSeeded).toBe(true);
    expect(findTemplateByName(db, "house", "Standard Repo")).toBeNull();
  });
});

/* ================================================================== */
/* Derivation parity + cleanup (default ACOTAR houses)                */
/* ================================================================== */

describe("derived default house templates", () => {
  it("DEFAULT_TEMPLATES is exactly 10 derived house templates + the project template", () => {
    const houses = DEFAULT_TEMPLATES.filter((t) => t.kind === "house");
    const projects = DEFAULT_TEMPLATES.filter((t) => t.kind === "project");
    expect(houses).toHaveLength(DEFAULT_HOUSES.length);
    expect(houses).toHaveLength(10);
    expect(projects.map((t) => t.name)).toEqual(["Standard Repo"]);
    expect(houses.map((t) => t.name)).toEqual(DEFAULT_HOUSES.map((h) => h.house.name));
  });

  it("matches DEFAULT_HOUSES one-for-one (name + payload agent/configuration)", () => {
    for (const h of DEFAULT_HOUSES) {
      const tpl = DEFAULT_TEMPLATES.find((t) => t.kind === "house" && t.name === h.house.name);
      expect(tpl, `missing derived template for ${h.house.name}`).toBeTruthy();
      const payload = tpl!.payload as unknown as HouseTemplatePayload;
      expect(payload.description).toBe(h.house.description);
      expect(payload.agent).toEqual({ name: h.agent.name, role: h.agent.role });
      expect(payload.configuration).toEqual(h.configuration);
    }
  });

  it("every derived house payload parses against the strict houseTemplatePayloadSchema", () => {
    for (const t of DEFAULT_TEMPLATES) {
      if (t.kind !== "house") continue;
      expect(() => houseTemplatePayloadSchema.parse(t.payload)).not.toThrow();
      // `.strict()`: the payload must carry exactly description/agent/configuration.
      const parsed = houseTemplatePayloadSchema.parse(t.payload);
      expect(Object.keys(parsed).sort()).toEqual(["agent", "configuration", "description"]);
      expect("name" in parsed).toBe(false);
    }
  });

  it("the seeder writes exactly DEFAULT_TEMPLATES; each derived payload persists", () => {
    const db = getDb();
    const inserted = seedDefaultTemplates(db);
    expect(inserted).toBe(DEFAULT_TEMPLATES.length);
    const all = listTemplates(db);
    expect(all.map((t) => `${t.kind}:${t.name}`).sort()).toEqual(
      DEFAULT_TEMPLATES.map((t) => `${t.kind}:${t.name}`).sort(),
    );
    const dayCourt = findTemplateByName(db, "house", "Day Court")!;
    const payload = dayCourt.payload as HouseTemplatePayload;
    expect(payload.agent.name).toBe("Helion");
    expect(payload.configuration.modelId).toBe("deepseek-v4.1-flash");
  });
});

describe("seedDefaultTemplates cleanup (superseded seeds)", () => {
  /** Pre-insert a seeded row directly (simulates an older boot's defaults). */
  function insertSeededHouse(db: ReturnType<typeof getDb>, name: string): string {
    const id = `seed-${name.replace(/\s+/g, "-").toLowerCase()}`;
    getRawDb()
      .prepare(
        `INSERT INTO templates (id, kind, name, description, payload, is_seeded, created_at, updated_at)
         VALUES (?, 'house', ?, 'superseded', ?, 1, ?, ?)`,
      )
      .run(id, name, JSON.stringify(housePayload()), new Date().toISOString(), new Date().toISOString());
    return id;
  }

  it("removes superseded seeded house templates; user + project templates survive", () => {
    const db = getDb();
    const researchId = insertSeededHouse(db, "Research House");
    const engineeringId = insertSeededHouse(db, "Engineering House");
    // A user-created house template (is_seeded=0) that shares an old seed's name.
    const userResearch = createTemplate(db, {
      kind: "house",
      name: "Research House (mine)",
      payload: housePayload(),
    });
    // A user-created house template (is_seeded=0) whose name is NOT a current
    // default — must survive because cleanup only touches is_seeded=1.
    createTemplate(db, { kind: "house", name: "Old World", payload: housePayload() });

    seedDefaultTemplates(db);

    // Superseded SEEDED rows are gone.
    expect(findTemplateByName(db, "house", "Research House")).toBeNull();
    expect(findTemplateByName(db, "house", "Engineering House")).toBeNull();
    expect(getTemplate(db, researchId)).toBeNull();
    expect(getTemplate(db, engineeringId)).toBeNull();
    // User template survives, seeded project survives.
    expect(getTemplate(db, userResearch.id)).toBeTruthy();
    expect(findTemplateByName(db, "project", "Standard Repo")).toBeTruthy();
    // Exactly the current default set remains on the house side (+ user rows).
    const houseNames = listTemplates(db, { kind: "house" }).map((t) => t.name);
    for (const h of DEFAULT_HOUSES) expect(houseNames).toContain(h.house.name);
    expect(houseNames).not.toContain("Research House");
    expect(houseNames).not.toContain("Engineering House");
  });

  it("is idempotent — a second run deletes nothing and inserts nothing", () => {
    const db = getDb();
    insertSeededHouse(db, "Docs House");
    seedDefaultTemplates(db);
    const afterFirst = listTemplates(db).map((t) => t.id).sort();
    const second = seedDefaultTemplates(db);
    expect(second).toBe(0);
    expect(listTemplates(db).map((t) => t.id).sort()).toEqual(afterFirst);
  });

  it("never deletes a user-created house template even if its name is absent from defaults", () => {
    const db = getDb();
    const user = createTemplate(db, { kind: "house", name: "Entirely Mine", payload: housePayload() });
    seedDefaultTemplates(db);
    expect(getTemplate(db, user.id)).toBeTruthy();
    expect(findTemplateByName(db, "house", "Entirely Mine")!.isSeeded).toBe(false);
  });
});

/* ================================================================== */
/* Seeded immutability                                                */
/* ================================================================== */

describe("seeded templates are immutable", () => {
  it("update/delete throw SeededTemplateError", () => {
    const db = getDb();
    seedDefaultTemplates(db);
    const seeded = findTemplateByName(db, "house", "Day Court")!;

    expect(() => updateTemplate(db, seeded.id, { name: "Hacked" })).toThrow(SeededTemplateError);
    expect(() => deleteTemplate(db, seeded.id)).toThrow(SeededTemplateError);
    // Untouched.
    expect(getTemplate(db, seeded.id)!.name).toBe("Day Court");
    // The ten derived house templates are present (the old 3 were replaced).
    expect(listTemplates(db, { kind: "house" })).toHaveLength(DEFAULT_HOUSES.length);
  });

  it("service-level update/delete on a seeded template also throws", () => {
    const db = getDb();
    seedDefaultTemplates(db);
    const seeded = findTemplateByName(db, "project", "Standard Repo")!;
    expect(() => updateTemplateService(db, seeded.id, { name: "X" })).toThrow(SeededTemplateError);
    expect(() => deleteTemplateService(db, seeded.id)).toThrow(SeededTemplateError);
  });
});

/* ================================================================== */
/* Service validation + audit                                         */
/* ================================================================== */

describe("template service", () => {
  it("validates create input and writes a create audit row", () => {
    const db = getDb();
    const t = createTemplateService(db, {
      kind: "house",
      name: "Audited",
      payload: housePayload(),
    });
    const entries = listAuditLog(db, { entityType: "template" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "user",
      action: "create",
      entityType: "template",
      entityId: t.id,
    });
  });

  it("rejects a kind/payload mismatch at the schema boundary", () => {
    const db = getDb();
    // A project payload with kind=house must fail discriminated-union parsing.
    expect(() =>
      createTemplateService(db, {
        kind: "house",
        name: "Bad",
        payload: projectPayload(),
      }),
    ).toThrow();
  });

  it("writes update + delete audit rows for user templates", () => {
    const db = getDb();
    const t = createTemplateService(db, { kind: "project", name: "T", payload: projectPayload() });
    updateTemplateService(db, t.id, { description: "updated" });
    deleteTemplateService(db, t.id);
    const actions = listAuditLog(db, { entityType: "template" }).map((e) => e.action).sort();
    expect(actions).toEqual(["create", "delete", "update"]);
  });
});

/* ================================================================== */
/* Instantiation — the §10 acceptance criterion                       */
/* ================================================================== */

describe("instantiateHouseTemplate", () => {
  it("creates a fully configured house from the template payload", () => {
    const db = getDb();
    const t = createTemplate(db, {
      kind: "house",
      name: "Templar House",
      payload: housePayload(),
    });

    const house = instantiateHouseTemplate(db, t.id);
    expect(house.name).toBe("Templar House");
    expect(house.agent.name).toBe("Templar");
    expect(house.agent.role).toBe("Knight · engineer");
    expect(house.configuration.modelId).toBe("glm-5.3");
    expect(house.configuration.executionProvider).toBe("opencode");
    expect(house.configuration.workspaceAllowlist).toEqual([tmpDir]);
    expect(house.configuration.tools).toEqual(["fs", "git"]);
    expect(house.configuration.approvalPolicy).toBe("always");
    expect(house.agents).toHaveLength(1);
    // Persisted + appears in the normal house list, editable normally.
    expect(getHouse(db, house.id)).toBeTruthy();
    expect(listHouses(db).some((h) => h.id === house.id)).toBe(true);
  });

  it("honours name / agentName overrides", () => {
    const db = getDb();
    const t = createTemplate(db, { kind: "house", name: "Base", payload: housePayload() });
    const house = instantiateHouseTemplate(db, t.id, { name: "My House", agentName: "Cassian" });
    expect(house.name).toBe("My House");
    expect(house.agent.name).toBe("Cassian");
    expect(house.agent.role).toBe("Knight · engineer"); // from template
  });

  it("writes an `instantiate` audit row referencing the template", () => {
    const db = getDb();
    const t = createTemplate(db, { kind: "house", name: "Audit House", payload: housePayload() });
    const house = instantiateHouseTemplate(db, t.id);
    const entry = listAuditLog(db, { entityType: "house" }).find((e) => e.action === "instantiate");
    expect(entry).toBeTruthy();
    expect(entry!.entityId).toBe(house.id);
    expect(entry!.metadata).toMatchObject({ templateId: t.id, templateName: "Audit House" });
  });

  it("throws TemplateNotFoundError for an unknown id and KindMismatch for the wrong kind", () => {
    const db = getDb();
    expect(() => instantiateHouseTemplate(db, "missing")).toThrow(TemplateNotFoundError);
    const project = createTemplate(db, { kind: "project", name: "P", payload: projectPayload() });
    expect(() => instantiateHouseTemplate(db, project.id)).toThrow(TemplateKindMismatchError);
  });
});

describe("instantiateProjectTemplate", () => {
  it("creates a project with description/model/instructions; directory is supplied", () => {
    const db = getDb();
    const t = createTemplate(db, { kind: "project", name: "Repo Template", payload: projectPayload() });
    const project = instantiateProjectTemplate(db, t.id, { directory: tmpDir });
    expect(project.name).toBe("Repo Template");
    expect(project.directory).toBe(tmpDir);
    expect(project.description).toBe("A repo project");
    expect(project.defaultModel).toBe("glm-5.3");
    expect(project.instructions).toBe("Read conventions first.");
    // Persisted.
    expect(listProjects(db).some((p) => p.id === project.id)).toBe(true);
  });

  it("validates the directory via the existing repo checks (nonexistent → throws)", () => {
    const db = getDb();
    const t = createTemplate(db, { kind: "project", name: "Bad Dir", payload: projectPayload() });
    expect(() =>
      instantiateProjectTemplate(db, t.id, { directory: path.join(tmpDir, "nope") }),
    ).toThrow(/does not exist/);
  });

  it("rejects a duplicate directory (assertDirectoryUnique) and a house template", () => {
    const db = getDb();
    const t = createTemplate(db, { kind: "project", name: "Repo", payload: projectPayload() });
    instantiateProjectTemplate(db, t.id, { directory: tmpDir });
    expect(() => instantiateProjectTemplate(db, t.id, { directory: tmpDir })).toThrow(
      /already exists/,
    );

    const house = createTemplate(db, { kind: "house", name: "H", payload: housePayload() });
    expect(() => instantiateProjectTemplate(db, house.id, { directory: tmpDir })).toThrow(
      TemplateKindMismatchError,
    );
  });

  it("writes an `instantiate` audit row for the project", () => {
    const db = getDb();
    const t = createTemplate(db, { kind: "project", name: "Audited Repo", payload: projectPayload() });
    const project = instantiateProjectTemplate(db, t.id, { directory: tmpDir });
    const entry = listAuditLog(db, { entityType: "project" }).find(
      (e) => e.action === "instantiate",
    );
    expect(entry!.entityId).toBe(project.id);
    expect(entry!.metadata).toMatchObject({ templateId: t.id });
  });
});
