/**
 * Unit tests — seeding the ten default ACOTAR houses (design spec §9).
 *
 * Covers:
 *  - fresh DB → 10 inserted; a second run inserts 0 (idempotent);
 *  - no-clobber: a user edit to a seeded house survives a re-seed; no duplicate;
 *  - roster integrity: one agent + complete configuration each, 10 unique names,
 *    every entry on opencode / ollama-cloud / deepseek-v4.1-flash;
 *  - a user house that collides by exact name blocks the default (skipped, not
 *    renamed/merged/deleted);
 *  - the raw-connection path (engine boot) works and is idempotent;
 *  - High Lord seeding is untouched by the default-house seed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import {
  seedDefaultHouses,
  seedHighLordHouse,
  findHighLordHouse,
  listHouses,
  getHouse,
  createHouse,
  transitionHouseStatus,
} from "@/server/repositories/house-repo";
import { updateHouseService } from "@/server/services/house-service";
import { DEFAULT_HOUSES, DEFAULT_TEMPLATES } from "@/shared/constants";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-defhouses-"));
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
/* Roster integrity (constant-level, no DB)                           */
/* ================================================================== */

describe("DEFAULT_HOUSES roster integrity", () => {
  it("has exactly the ten approved entries in order, with unique names", () => {
    expect(DEFAULT_HOUSES).toHaveLength(10);
    const names = DEFAULT_HOUSES.map((h) => h.house.name);
    expect(new Set(names).size).toBe(10);
    expect(names[0]).toBe("Day Court");
    expect(names).toEqual([
      "Day Court",
      "House of Shadow",
      "Hewn City",
      "The Library",
      "Court of Truth",
      "The Townhouse",
      "Summer Court",
      "Windhaven",
      "The Crossing",
      "Illyria",
    ]);
  });

  it("every entry has an agent, a description, and a complete configuration", () => {
    for (const h of DEFAULT_HOUSES) {
      expect(h.house.description.trim().length).toBeGreaterThan(0);
      expect(h.agent.name.trim().length).toBeGreaterThan(0);
      expect(h.agent.role.trim().length).toBeGreaterThan(0);
      expect(h.configuration.systemPrompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("every entry uses opencode + ollama-cloud + deepseek-v4.1-flash, allowlist [], concurrency 1", () => {
    for (const h of DEFAULT_HOUSES) {
      expect(h.configuration.executionProvider).toBe("opencode");
      expect(h.configuration.aiProvider).toBe("ollama-cloud");
      expect(h.configuration.modelId).toBe("deepseek-v4.1-flash");
      expect(h.configuration.workspaceAllowlist).toEqual([]);
      expect(h.configuration.concurrency).toBe(1);
    }
  });

  it("every entry's permissions + approval policy match the approved matrix", () => {
    const byName = Object.fromEntries(DEFAULT_HOUSES.map((h) => [h.house.name, h]));
    expect(byName["Day Court"].configuration.permissions).toEqual({
      fileSystem: "ask",
      shell: "ask",
      network: "ask",
      git: "allow",
    });
    expect(byName["Day Court"].configuration.approvalPolicy).toBe("risky_only");
    expect(byName["House of Shadow"].configuration.tools).toEqual(["fs", "shell", "git"]);
    expect(byName["Hewn City"].configuration.permissions).toEqual({
      fileSystem: "ask",
      shell: "ask",
      network: "deny",
      git: "allow",
    });
    expect(byName["The Library"].configuration.tools).toEqual(["fs", "git"]);
    expect(byName["The Library"].configuration.permissions.shell).toBe("deny");
    expect(byName["Court of Truth"].configuration.tools).toEqual(["fs"]);
    expect(byName["Court of Truth"].configuration.permissions).toEqual({
      fileSystem: "ask",
      shell: "deny",
      network: "ask",
      git: "deny",
    });
    expect(byName["Summer Court"].configuration.permissions.network).toBe("deny");
    expect(byName["Windhaven"].configuration.permissions.git).toBe("deny");
    expect(byName["The Crossing"].configuration.tools).toEqual(["fs"]);
    expect(byName["Illyria"].configuration.approvalPolicy).toBe("risky_only");
    expect(byName["Illyria"].configuration.tools).toEqual(["fs", "shell", "git"]);
  });

  it("each systemPrompt is distinct and role-specific (not a shared template)", () => {
    const prompts = DEFAULT_HOUSES.map((h) => h.configuration.systemPrompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    // Each prompt names its own character, so they are genuinely per-house.
    for (const h of DEFAULT_HOUSES) {
      expect(h.configuration.systemPrompt).toContain(h.agent.name);
    }
  });

  it("prompts never claim a permission is unavailable or read-only when the config grants it", () => {
    // A prompt must state the ACTUAL configured posture: if it says "no network"
    // or "read-only filesystem" the config must deny that permission, and if the
    // config grants it ask/allow the prompt must not claim it is absent or
    // read-only. Same for shell and git.
    type PermKey = keyof typeof DEFAULT_HOUSES[number]["configuration"]["permissions"];
    // Read-only claims are scoped to a nearby permission keyword (within the same
    // sentence, so no cross-sentence false positives) so legitimate uses such as
    // "read-only view" or a "read-only artifacts API" never trip the assertion.
    const restrictionClaims: Array<{ kind: string; phrase: RegExp; perm: PermKey }> = [
      { kind: "unavailable", phrase: /\bno network\b/i, perm: "network" },
      { kind: "unavailable", phrase: /\bno shell\b/i, perm: "shell" },
      { kind: "unavailable", phrase: /\bno git\b/i, perm: "git" },
      {
        kind: "read-only",
        // "read-only filesystem" / "the files are read-only"
        phrase:
          /\bread[- ]only\b[^.]{0,40}\b(?:filesystem|file system|files?)\b|\b(?:filesystem|file system|files?)\b[^.]{0,40}\bread[- ]only\b/i,
        perm: "fileSystem",
      },
      {
        kind: "read-only",
        // "read-only git" / "git ... treat it as read-only"
        phrase: /\bread[- ]only\b[^.]{0,40}\bgit\b|\bgit\b[^.]{0,40}\bread[- ]only\b/i,
        perm: "git",
      },
    ];
    for (const h of DEFAULT_HOUSES) {
      const prompt = h.configuration.systemPrompt;
      for (const { kind, phrase, perm } of restrictionClaims) {
        if (phrase.test(prompt)) {
          expect(
            h.configuration.permissions[perm],
            `${h.house.name} prompt claims ${perm} is "${kind}" but config is ${h.configuration.permissions[perm]}`,
          ).toBe("deny");
        }
        if (h.configuration.permissions[perm] !== "deny") {
          expect(
            phrase.test(prompt),
            `${h.house.name} config grants ${perm}='${h.configuration.permissions[perm]}' but prompt claims it is "${kind}"`,
          ).toBe(false);
        }
      }
    }
  });

  it("clones each derived template configuration — never shares a reference with DEFAULT_HOUSES", () => {
    const houseTemplates = DEFAULT_TEMPLATES.filter((t) => t.kind === "house");
    expect(houseTemplates).toHaveLength(DEFAULT_HOUSES.length);
    DEFAULT_HOUSES.forEach((h, i) => {
      const payload = houseTemplates[i].payload as {
        configuration: HouseConfiguration;
      };
      // Distinct objects all the way down: mutating a template payload must not
      // corrupt the house seed (and vice versa).
      expect(payload.configuration).not.toBe(h.configuration);
      expect(payload.configuration.permissions).not.toBe(h.configuration.permissions);
      expect(payload.configuration.tools).not.toBe(h.configuration.tools);
      expect(payload.configuration.workspaceAllowlist).not.toBe(h.configuration.workspaceAllowlist);

      const before = h.configuration.permissions.network;
      const mutatedPerm = before === "deny" ? "allow" : "deny";
      payload.configuration.permissions.network = mutatedPerm;
      payload.configuration.tools.push("mutated");
      expect(h.configuration.permissions.network).toBe(before);
      expect(h.configuration.tools).not.toContain("mutated");
      // Restore the derived payload so this probe cannot leak into later tests.
      payload.configuration.permissions.network = before;
      payload.configuration.tools.pop();
    });
  });
});

/* ================================================================== */
/* Seeding behaviour                                                  */
/* ================================================================== */

describe("seedDefaultHouses", () => {
  it("inserts exactly 10 houses on a fresh DB; a second run inserts 0", () => {
    const db = getDb();
    expect(seedDefaultHouses(db)).toBe(10);
    expect(seedDefaultHouses(db)).toBe(0);

    const listed = listHouses(db);
    expect(listed).toHaveLength(10);
    expect(listed.map((h) => h.name).sort()).toEqual(
      DEFAULT_HOUSES.map((h) => h.house.name).sort(),
    );
  });

  it("creates one agent + a complete configuration per house", () => {
    const db = getDb();
    seedDefaultHouses(db);
    for (const entry of DEFAULT_HOUSES) {
      const house = listHouses(db).find((h) => h.name === entry.house.name)!;
      expect(house.kind).toBe("agent");
      expect(house.status).toBe("active");
      expect(house.agents).toHaveLength(1);
      expect(house.agent.name).toBe(entry.agent.name);
      expect(house.agent.role).toBe(entry.agent.role);
      expect(house.configuration).toEqual(entry.configuration);
    }
  });

  it("does NOT clobber a user edit to a seeded house (no-clobber, no duplicate)", () => {
    const db = getDb();
    seedDefaultHouses(db);
    const dayCourt = listHouses(db).find((h) => h.name === "Day Court")!;

    // Simulate a user editing agent + permission via the standard service.
    updateHouseService(db, dayCourt.id, {
      agent: { name: "Helion Edited" },
      configuration: { modelId: "llama-4", permissions: { ...dayCourt.configuration.permissions, git: "deny" } },
    });

    // Re-seed (e.g. next boot) — the edit must win, and nothing new is inserted.
    expect(seedDefaultHouses(db)).toBe(0);
    const after = getHouse(db, dayCourt.id)!;
    expect(after.agent.name).toBe("Helion Edited");
    expect(after.configuration.modelId).toBe("llama-4");
    expect(after.configuration.permissions.git).toBe("deny");
    // No duplicate Day Court.
    expect(listHouses(db).filter((h) => h.name === "Day Court")).toHaveLength(1);
  });

  it("skips a default when ANY house with that exact name already exists (any status)", () => {
    const db = getDb();
    // A user-created house that claims the default's name, then gets disabled.
    const userDay = createHouse(db, {
      name: "Day Court",
      description: "mine",
      agent: { name: "Not Helion", role: "custom" },
      configuration: {
        systemPrompt: "custom prompt",
        executionProvider: "ollama",
        aiProvider: "ollama",
        modelId: "custom-model",
        workspaceAllowlist: [],
        tools: ["fs"],
        permissions: { fileSystem: "ask", shell: "deny", network: "deny", git: "deny" },
        approvalPolicy: "always",
        concurrency: 1,
      },
    });
    transitionHouseStatus(db, userDay.id, "disabled");

    // Seed: the other nine insert; "Day Court" is skipped untouched.
    expect(seedDefaultHouses(db)).toBe(9);
    const day = getHouse(db, userDay.id)!;
    expect(day.agent.name).toBe("Not Helion");
    expect(day.configuration.modelId).toBe("custom-model");
    expect(day.status).toBe("disabled");
    expect(listHouses(db, { includeArchived: true }).filter((h) => h.name === "Day Court")).toHaveLength(1);
  });

  it("re-creates a renamed default while preserving the renamed house (documented behaviour)", () => {
    const db = getDb();
    seedDefaultHouses(db);
    const day = listHouses(db).find((h) => h.name === "Day Court")!;
    const originalAgent = day.agent.name;

    // Rename the seeded house via the standard update path (exact-name matching
    // means "Day Court" is now considered absent on the next seed).
    updateHouseService(db, day.id, { name: "My Day Court" });

    // Next boot re-creates the default; the renamed house is untouched.
    expect(seedDefaultHouses(db)).toBe(1);
    const names = listHouses(db)
      .filter((h) => h.name === "Day Court" || h.name === "My Day Court")
      .map((h) => h.name)
      .sort();
    expect(names).toEqual(["Day Court", "My Day Court"]);
    // The renamed row survives with its agent intact (same id, not clobbered).
    const renamed = getHouse(db, day.id)!;
    expect(renamed.name).toBe("My Day Court");
    expect(renamed.agent.name).toBe(originalAgent);
    // The re-created default is a NEW row, not a rename-back.
    const recreated = listHouses(db).find((h) => h.name === "Day Court")!;
    expect(recreated.id).not.toBe(day.id);
    expect(recreated.agent.name).toBe(originalAgent);
  });

  it("works via the raw connection (engine boot) and is idempotent", () => {
    const raw = getRawDb();
    expect(seedDefaultHouses(raw)).toBe(10);
    expect(seedDefaultHouses(raw)).toBe(0);
    expect(listHouses(getDb())).toHaveLength(10);
  });

  it("leaves the seeded High Lord untouched", () => {
    const db = getDb();
    seedHighLordHouse(db);
    const hl = findHighLordHouse(db)!;
    expect(seedDefaultHouses(getRawDb())).toBe(10);
    // Still exactly one High Lord, unchanged.
    expect(findHighLordHouse(db)!.id).toBe(hl.id);
    expect(findHighLordHouse(db)!.kind).toBe("high_lord");
    // listHouses excludes the HL by default: only the ten defaults show.
    expect(listHouses(db)).toHaveLength(10);
  });
});
