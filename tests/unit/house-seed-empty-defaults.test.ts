/**
 * ADVERSARIAL: cleanup behaviour when the default house set is EMPTY.
 *
 * The design's biggest footgun would be "one release removes all default houses
 * and the cleanup wipes every seeded house template". This isolates the cleanup
 * by mocking DEFAULT_HOUSES=[] (and DEFAULT_TEMPLATES to just the project
 * template) and asserting a previously-seeded house template is NOT deleted.
 *
 * The implementation guards with `if (houseNames.length)`, so an empty default
 * set is a NO-OP (stale seeded house templates persist — safe, but never
 * garbage-collected). This test locks that guarantee in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/shared/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/constants")>();
  return {
    ...actual,
    DEFAULT_HOUSES: [],
    DEFAULT_TEMPLATES: actual.DEFAULT_TEMPLATES.filter((t) => t.kind === "project"),
  };
});

import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { seedDefaultTemplates, findTemplateByName } from "@/server/repositories/template-repo";
import { DEFAULT_TEMPLATES } from "@/shared/constants";

let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-emptyd-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ADVERSARIAL cleanup with an empty DEFAULT_HOUSES", () => {
  it("does NOT wipe a pre-existing seeded house template", () => {
    expect(DEFAULT_TEMPLATES.every((t) => t.kind === "project")).toBe(true);
    getRawDb()
      .prepare(
        `INSERT INTO templates (id, kind, name, description, payload, is_seeded, created_at, updated_at)
         VALUES ('old-house','house','Day Court','old',?,1,?,?)`,
      )
      .run("{}", new Date().toISOString(), new Date().toISOString());

    expect(seedDefaultTemplates(getDb())).toBe(1); // only Standard Repo
    // The guard means no DELETE runs when there are zero default house names.
    expect(findTemplateByName(getDb(), "house", "Day Court")).toBeTruthy();
  });

  it("still seeds the project template when house defaults are empty", () => {
    expect(seedDefaultTemplates(getDb())).toBe(1);
    expect(findTemplateByName(getDb(), "project", "Standard Repo")).toBeTruthy();
  });
});
