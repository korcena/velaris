/**
 * Unit tests — quest auto-assignment routing
 * (src/server/execution/planning/route-quest.ts).
 *
 * Covers the deterministic pick, tie/weak/no-candidate escalation, terminal
 * failures, and the workspace-viability filter (A1). The workspace cases use
 * REAL temp directories because `isPathAllowed` calls `fs.realpathSync`.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseQuestHouse } from "@/server/execution/planning/route-quest";
import type { HouseConfiguration, HouseDto } from "@/shared/types";

function config(workspaceAllowlist: string[]): HouseConfiguration {
  return {
    systemPrompt: "",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist,
    tools: [],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

function house(over: Partial<HouseDto> & { id: string; name: string }): HouseDto {
  return {
    description: null,
    kind: "agent",
    status: "active",
    agent: { name: "", role: "" },
    agents: [],
    configuration: config([]),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** High Lord with a non-empty allowlist, so escalation has a directory. */
function highLord(id = "hl"): HouseDto {
  return house({
    id,
    name: "High Lord",
    description: "Plans and delegates",
    kind: "high_lord",
    agent: { name: "Rhysand", role: "High Lord" },
    configuration: config(["/tmp/velaris-hl"]),
  });
}

const tempDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("chooseQuestHouse — deterministic routing", () => {
  it("routes to the unique best-scoring viable house (score above threshold, margin >= 1)", () => {
    const dir = mkTmp("velaris-route-deterministic-");
    const mist = house({
      id: "h-mist",
      name: "House of Mist",
      description: "Wards and illusions",
      agent: { name: "Azriel", role: "Spymaster" },
      configuration: config([dir]),
    });
    const wind = house({
      id: "h-wind",
      name: "House of Wind",
      description: "Combat and fortification",
      agent: { name: "Cassian", role: "General" },
      configuration: config([dir]),
    });

    const decision = chooseQuestHouse(
      {
        title: "Mist warding",
        type: "general",
        description: "spymaster illusions",
        workingDirectory: null,
        projectDirectory: null,
      },
      [mist, wind],
      new Map([
        [mist.id, [dir]],
        [wind.id, [dir]],
      ]),
    );

    // mist: spymaster + illusions + mist = 3; wind: general = 1.
    expect(decision).toEqual({ houseId: mist.id, escalated: false, reason: "scored", score: 3 });
  });
});

describe("chooseQuestHouse — escalation", () => {
  it("escalates on a tie (equal top scores, margin 0)", () => {
    const dir = mkTmp("velaris-route-tie-");
    const alpha = house({
      id: "h-alpha",
      name: "Alpha",
      description: "research analysis",
      agent: { name: "One", role: "Researcher" },
      configuration: config([dir]),
    });
    const beta = house({
      id: "h-beta",
      name: "Beta",
      description: "research analysis",
      agent: { name: "Two", role: "Researcher" },
      configuration: config([dir]),
    });
    const hl = highLord();

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "general",
        description: "research analysis",
        workingDirectory: null,
        projectDirectory: null,
      },
      [alpha, beta, hl],
      new Map([
        [alpha.id, [dir]],
        [beta.id, [dir]],
        [hl.id, hl.configuration.workspaceAllowlist],
      ]),
    );

    // Both score 2; margin 0 < MIN_SCORE_MARGIN → escalate.
    expect(decision).toEqual({ houseId: hl.id, escalated: true, reason: "weak_match", score: 2 });
  });

  it("escalates a weak single-word overlap (score 1 < MIN_ROUTE_SCORE)", () => {
    const dir = mkTmp("velaris-route-weak-");
    const houseOfNight = house({
      id: "h-night",
      name: "House of Night",
      description: "Starlight",
      agent: { name: "Nyx", role: "Watcher" },
      configuration: config([dir]),
    });
    const hl = highLord();

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "general",
        description: "starlight",
        workingDirectory: null,
        projectDirectory: null,
      },
      [houseOfNight, hl],
      new Map([
        [houseOfNight.id, [dir]],
        [hl.id, hl.configuration.workspaceAllowlist],
      ]),
    );

    expect(decision).toEqual({ houseId: hl.id, escalated: true, reason: "weak_match", score: 1 });
  });

  it("escalates when there are no active agent houses", () => {
    const hl = highLord();

    const decision = chooseQuestHouse(
      { title: "Quest", type: "general", description: "anything", workingDirectory: null, projectDirectory: null },
      [hl],
      new Map([[hl.id, hl.configuration.workspaceAllowlist]]),
    );

    expect(decision).toEqual({
      houseId: hl.id,
      escalated: true,
      reason: "no_agent_houses",
      score: 0,
    });
  });
});

describe("chooseQuestHouse — terminal failures", () => {
  it("fails with no_high_lord when there are no candidates and no High Lord", () => {
    const decision = chooseQuestHouse(
      { title: "Quest", type: "general", description: "anything", workingDirectory: null, projectDirectory: null },
      [],
      new Map(),
    );

    expect(decision).toEqual({
      houseId: null,
      escalated: false,
      reason: "no_high_lord",
      score: 0,
    });
  });

  it("fails with no_directory when the High Lord has no resolvable directory", () => {
    const hl = house({
      id: "hl",
      name: "High Lord",
      kind: "high_lord",
      agent: { name: "Rhysand", role: "High Lord" },
      configuration: config([]),
    });

    const decision = chooseQuestHouse(
      { title: "Quest", type: "general", description: "anything", workingDirectory: null, projectDirectory: null },
      [hl],
      new Map([[hl.id, []]]),
    );

    expect(decision).toEqual({
      houseId: null,
      escalated: false,
      reason: "no_directory",
      score: 0,
    });
  });
});

describe("chooseQuestHouse — workspace-viability filter (A1, mirrors resolveWorkspace)", () => {
  /** A house that scores 2 on "research analysis" quest text. */
  function researchHouse(id: string, allowlist: string[]): HouseDto {
    return house({
      id,
      name: "Research Hall",
      description: "research analysis",
      agent: { name: "Scholar", role: "Researcher" },
      configuration: config(allowlist),
    });
  }

  it("excludes a house whose allowlist does not contain the working directory, routing the viable one", () => {
    const allowedDir = mkTmp("velaris-route-allowed-");
    const otherDir = mkTmp("velaris-route-other-");

    // Scores 3 on the quest text but its allowlist is a different directory.
    const excluded = house({
      id: "h-excluded",
      name: "House of Mist",
      description: "illusions spymaster wards",
      agent: { name: "Azriel", role: "Spymaster" },
      configuration: config([otherDir]),
    });
    // Scores 2 on the quest text and its allowlist contains the directory.
    const viable = house({
      id: "h-viable",
      name: "House of Wind",
      description: "combat fortification",
      agent: { name: "Cassian", role: "General" },
      configuration: config([allowedDir]),
    });

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "task",
        description: "combat fortification illusions spymaster wards",
        workingDirectory: allowedDir,
        projectDirectory: null,
      },
      [excluded, viable],
      new Map([
        [excluded.id, [otherDir]],
        [viable.id, [allowedDir]],
      ]),
    );

    // Without the filter `excluded` (3) would win; with it only `viable` (2)
    // remains and routes.
    expect(decision).toEqual({ houseId: viable.id, escalated: false, reason: "scored", score: 2 });
  });

  it("excludes the only candidate when a non-empty allowlist does not contain the present working directory", () => {
    const dir = mkTmp("velaris-route-miss-");
    const otherDir = mkTmp("velaris-route-other2-");
    const excluded = researchHouse("h-miss", [otherDir]);
    const hl = highLord();

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "task",
        description: "research analysis",
        workingDirectory: dir,
        projectDirectory: null,
      },
      [excluded, hl],
      new Map([
        [excluded.id, [otherDir]],
        [hl.id, hl.configuration.workspaceAllowlist],
      ]),
    );

    expect(decision).toEqual({ houseId: hl.id, escalated: true, reason: "no_match", score: 0 });
  });

  it("excludes an empty effective allowlist when a working directory is present", () => {
    const dir = mkTmp("velaris-route-empty-");
    const hl = highLord();
    const emptyHouse = researchHouse("h-empty", []);

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "task",
        description: "research analysis",
        workingDirectory: dir,
        projectDirectory: null,
      },
      [emptyHouse, hl],
      new Map([
        [emptyHouse.id, []],
        [hl.id, hl.configuration.workspaceAllowlist],
      ]),
    );

    // Even scoring >= 2, an empty effective allowlist with a present directory
    // is not viable → no candidates survive → escalate as no_match.
    expect(decision).toEqual({ houseId: hl.id, escalated: true, reason: "no_match", score: 0 });
  });

  it("viable: empty house allowlist + present working directory inside the project-derived effective list", () => {
    const dir = mkTmp("velaris-route-projectdir-");
    const candidate = researchHouse("h-project", []);

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "task",
        description: "research analysis",
        workingDirectory: dir,
        projectDirectory: null,
      },
      [candidate],
      // Empty house allowlist → caller passes the registered-project dirs.
      new Map([[candidate.id, [dir]]]),
    );

    expect(decision).toEqual({ houseId: candidate.id, escalated: false, reason: "scored", score: 2 });
  });

  it("default Board flow (regression): null workingDirectory + empty house allowlist + null projectDirectory is NOT viable → escalate", () => {
    const registeredProject = mkTmp("velaris-route-registered-");
    const hl = highLord();
    // Would score 2 on the quest text, but has no runnable directory.
    const emptyHouse = researchHouse("h-empty", []);

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "task",
        description: "research analysis",
        workingDirectory: null,
        projectDirectory: null,
      },
      [emptyHouse, hl],
      // The effective list is NON-EMPTY (a registered project exists) — the old
      // "empty effective list is viable" rule would wrongly route here and then
      // fail at claim. resolveWorkspace instead ignores the project fallback
      // because there is no task project directory, so this house is excluded.
      new Map([
        [emptyHouse.id, [registeredProject]],
        [hl.id, hl.configuration.workspaceAllowlist],
      ]),
    );

    expect(decision).toEqual({ houseId: hl.id, escalated: true, reason: "no_match", score: 0 });
  });

  it("viable: null workingDirectory + empty house allowlist + a task project directory", () => {
    const projectDir = mkTmp("velaris-route-proj-");
    const candidate = researchHouse("h-proj", []);

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "task",
        description: "research analysis",
        workingDirectory: null,
        projectDirectory: projectDir,
      },
      [candidate],
      new Map([[candidate.id, [projectDir]]]),
    );

    expect(decision).toEqual({ houseId: candidate.id, escalated: false, reason: "scored", score: 2 });
  });

  it("viable: null workingDirectory + non-empty house allowlist uses the allowlist[0] fallback", () => {
    const dir = mkTmp("velaris-route-fallback-");
    const candidate = researchHouse("h-fallback", [dir]);

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "task",
        description: "research analysis",
        workingDirectory: null,
        projectDirectory: null,
      },
      [candidate],
      new Map([[candidate.id, [dir]]]),
    );

    expect(decision).toEqual({ houseId: candidate.id, escalated: false, reason: "scored", score: 2 });
  });

  it("viable: null workingDirectory + non-empty house allowlist with an existing first entry routes", () => {
    const existingDir = mkTmp("velaris-route-first-exists-");
    const candidate = researchHouse("h-first-exists", [
      existingDir,
      "/nonexistent/ignore-second-entry",
    ]);

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "task",
        description: "research analysis",
        workingDirectory: null,
        projectDirectory: null,
      },
      [candidate],
      new Map([
        [candidate.id, [existingDir, "/nonexistent/ignore-second-entry"]],
      ]),
    );

    expect(decision).toEqual({ houseId: candidate.id, escalated: false, reason: "scored", score: 2 });
  });

  it("excludes a house whose non-empty allowlist[0] does not exist on disk (true resolveWorkspace mirror) → escalate", () => {
    // A real, existing directory used for a second (irrelevant) allowlist entry,
    // plus a clearly non-existent FIRST entry. `resolveWorkspace`'s fallback is
    // `fallback && isPathAllowed(fallback, effectiveAllowlist)`, so this house
    // would fail at claim — the filter must exclude it rather than route-then-fail.
    const existingDir = mkTmp("velaris-route-missing-existent-");
    const missingDir = path.join(
      os.tmpdir(),
      `velaris-route-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const candidate = researchHouse("h-missing-first", [missingDir, existingDir]);
    const hl = highLord();

    const decision = chooseQuestHouse(
      {
        title: "Quest",
        type: "task",
        description: "research analysis",
        workingDirectory: null,
        projectDirectory: null,
      },
      [candidate, hl],
      new Map([
        [candidate.id, [missingDir, existingDir]],
        [hl.id, hl.configuration.workspaceAllowlist],
      ]),
    );

    // Excluded before scoring → no candidates survive → no_match, escalate to HL.
    expect(decision).toEqual({ houseId: hl.id, escalated: true, reason: "no_match", score: 0 });
  });
});
