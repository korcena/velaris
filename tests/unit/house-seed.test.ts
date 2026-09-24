/**
 * Unit tests — High Lord house seeding, list exclusion, guard (Phase 4 addendum).
 *
 * Covers:
 *  - `seedHighLordHouse` idempotence (second call is a no-op) + kind surfaced on DTO
 *  - `listHouses` default excludes the High Lord; includeHighLord opts in;
 *    `getHouse(hl)` still returns it (deep-link by id must work)
 *  - `findHighLordHouse` returns the singleton
 *  - The service-layer HL guard: transitions off `active` and DELETE reject via
 *    `HighLordTransitionError` (→ 422 via api-helpers); field-only PATCH is allowed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import {
  seedHighLordHouse,
  findHighLordHouse,
  listHouses,
  getHouse,
  createHouse,
} from "@/server/repositories/house-repo";
import {
  transitionHouseStatusService,
  deleteHouseService,
  updateHouseService,
  HighLordTransitionError,
} from "@/server/services/house-service";
import { HIGH_LORD_SEED } from "@/shared/constants";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

function makeConfig(): HouseConfiguration {
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
  };
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-hlseed-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("seedHighLordHouse", () => {
  it("seeds the singleton High Lord with kind + seed values (glm-5.3, never, Rhysand)", () => {
    const db = getDb();
    const hl = seedHighLordHouse(db);

    expect(hl).not.toBeNull();
    expect(hl?.name).toBe(HIGH_LORD_SEED.HOUSE_NAME);
    expect(hl?.kind).toBe("high_lord");
    expect(hl?.status).toBe("active");
    expect(hl?.agent.name).toBe(HIGH_LORD_SEED.AGENT_NAME);
    expect(hl?.agent.role).toBe(HIGH_LORD_SEED.AGENT_ROLE);
    expect(hl?.configuration.modelId).toBe("glm-5.3");
    expect(hl?.configuration.approvalPolicy).toBe("never");
    expect(hl?.configuration.executionProvider).toBe("opencode");
    expect(hl?.configuration.systemPrompt).toBe(HIGH_LORD_SEED.SYSTEM_PROMPT);
  });

  it("is idempotent — a second call is a no-op and does not clobber user edits", () => {
    const db = getDb();
    seedHighLordHouse(getRawDb());
    const hl = findHighLordHouse(db)!;

    // Simulate a user editing the model via the standard house form.
    updateHouseService(db, hl.id, { configuration: { modelId: "llama-4" } });

    // Re-seed (e.g. next boot) — must not resurrect glm-5.3.
    seedHighLordHouse(getRawDb());
    expect(findHighLordHouse(db)?.configuration.modelId).toBe("llama-4");
    expect(listHouses(db, { includeHighLord: true })).toHaveLength(1);
  });

  it("returns null DTO when given only a raw connection after seeding", () => {
    seedHighLordHouse(getRawDb());
    // Re-seed with the raw connection on an already-seeded DB → no DTO returned
    // (raw path cannot build a DTO), but it is still a no-op.
    expect(seedHighLordHouse(getRawDb())).toBeNull();
    expect(listHouses(getDb(), { includeHighLord: true })).toHaveLength(1);
  });
});

describe("list exclusion / get-by-id", () => {
  it("listHouses excludes the High Lord by default; includeHighLord includes it", () => {
    const db = getDb();
    seedHighLordHouse(getRawDb());
    const normal = createHouse(db, {
      name: "House of Mist",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });

    const visible = listHouses(db, {});
    expect(visible.map((h) => h.name)).toEqual(["House of Mist"]);
    expect(visible.some((h) => h.kind === "high_lord")).toBe(false);

    const all = listHouses(db, { includeHighLord: true });
    expect(all.map((h) => h.kind).sort()).toEqual(["agent", "high_lord"].sort());
  });

  it("getHouse(hl) returns the High Lord even though listHouses excludes it", () => {
    const db = getDb();
    const hl = seedHighLordHouse(db)!;
    expect(getHouse(db, hl.id)?.kind).toBe("high_lord");
    expect(findHighLordHouse(db)?.id).toBe(hl.id);
  });
});

describe("High Lord service guard (addendum D1)", () => {
  function seeded(): string {
    return seedHighLordHouse(getDb())!.id;
  }

  it("rejects disabling/archiving the High Lord (422-class HighLordTransitionError)", () => {
    const db = getDb();
    const id = seeded();
    expect(() => transitionHouseStatusService(db, id, "disabled")).toThrow(HighLordTransitionError);
    expect(() => transitionHouseStatusService(db, id, "archived")).toThrow(HighLordTransitionError);
    // The house remains active.
    expect(getHouse(db, id)?.status).toBe("active");
  });

  it("rejects deleting the High Lord unconditionally", () => {
    const db = getDb();
    const id = seeded();
    expect(() => deleteHouseService(db, id)).toThrow(HighLordTransitionError);
  });

  it("allows field-only PATCH (model edit) on the High Lord — editability preserved", () => {
    const db = getDb();
    const id = seeded();
    const updated = updateHouseService(db, id, { configuration: { modelId: "glm-5.3-plus" } });
    expect(updated.configuration.modelId).toBe("glm-5.3-plus");
    // Still the High Lord, still active.
    expect(updated.kind).toBe("high_lord");
    expect(updated.status).toBe("active");
  });

  it("does not guard ordinary agent houses (transitions still work)", () => {
    const db = getDb();
    const normal = createHouse(db, {
      name: "House of Mist",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    expect(() => transitionHouseStatusService(db, normal.id, "disabled")).not.toThrow();
    // A normal, non-archived house's delete is governed by the archive rule, not
    // the High Lord guard — it must NOT throw HighLordTransitionError.
    expect(() => deleteHouseService(db, normal.id)).not.toThrow(HighLordTransitionError);
  });
});
