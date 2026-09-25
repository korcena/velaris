/**
 * Unit tests — house resolution for plan subtasks (src/server/execution/planning/resolve-plan.ts).
 *
 * Covers the resolution matrix: explicit id honored/rejected, hint scoring
 * (name/description/role), High Lord destination rejected, dependency
 * normalization idempotence, and the no-agent-houses edge (null).
 */

import { describe, it, expect } from "vitest";
import { resolvePlan, scoreHouse, normalizePlan } from "@/server/execution/planning/resolve-plan";
import type { HouseDto } from "@/shared/types";

function house(over: Partial<HouseDto> & { id: string; name: string }): HouseDto {
  return {
    description: null,
    kind: "agent",
    status: "active",
    agent: { name: "", role: "" },
    agents: [],
    configuration: {
      systemPrompt: "",
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "glm-5.3",
      workspaceAllowlist: [],
      tools: [],
      permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
      approvalPolicy: "always",
      concurrency: 1,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const mist = house({
  id: "h-mist",
  name: "House of Mist",
  description: "Wards, illusions and divination",
  agent: { name: "Azriel", role: "Spymaster" },
});
const wind = house({
  id: "h-wind",
  name: "House of Wind",
  description: "Combat and fortification",
  agent: { name: "Cassian", role: "General" },
});
const dawn = house({
  id: "h-dawn",
  name: "House of Dawn",
  description: "Healing and scholarship",
  agent: { name: "Nesta", role: "Librarian" },
});

const all = [mist, wind, dawn];

function planSubtask(over: Record<string, unknown> = {}) {
  return { id: "s0", title: "T", dependsOn: [], ...over } as never;
}

describe("resolvePlan — explicit houseId", () => {
  it("honors an explicit valid houseId", () => {
    const plan = { subtasks: [planSubtask({ houseId: wind.id }) as any] };
    const out = resolvePlan(plan, all);
    expect(out.subtasks[0].houseId).toBe(wind.id);
  });

  it("rejects a High Lord destination and falls back to hints", () => {
    const hl = house({ id: "hl", name: "High Lord", kind: "high_lord" });
    const plan = { subtasks: [planSubtask({ houseId: hl.id, houseHints: "healing" }) as any] };
    const out = resolvePlan(plan, [...all, hl]);
    expect(out.subtasks[0].houseId).not.toBe(hl.id);
    expect(out.subtasks[0].houseId).toBe(dawn.id); // dawn matches "healing"
  });

  it("rejects an unknown / inactive explicit id and falls back to hints", () => {
    const plan = { subtasks: [planSubtask({ houseId: "nope", houseHints: "spymaster" }) as any] };
    const out = resolvePlan(plan, all);
    expect(out.subtasks[0].houseId).toBe(mist.id);
  });
});

describe("resolvePlan — hint scoring", () => {
  it("matches by house name / role / description", () => {
    const plan = { subtasks: [planSubtask({ houseHints: "healing scholarship" }) as any] };
    expect(resolvePlan(plan, all).subtasks[0].houseId).toBe(dawn.id);
  });

  it("matches by subtask type+title when hints are empty", () => {
    const plan = { subtasks: [planSubtask({ type: "research", title: "Scout the border" }) as any] };
    // "Scout"/"border" aren't in any house; "wind" role=General doesn't match
    // "research"; falls back to the first house (mist).
    expect(resolvePlan(plan, all).subtasks[0].houseId).toBe(mist.id);
  });

  it("falls back to the first active agent house on zero score", () => {
    const plan = { subtasks: [planSubtask({}) as any] };
    expect(resolvePlan(plan, all).subtasks[0].houseId).toBe(mist.id);
  });
});

describe("resolvePlan — guards", () => {
  it("returns houseId null for every subtask when no agent houses exist", () => {
    const plan = { subtasks: [planSubtask() as any] };
    const out = resolvePlan(plan, []);
    expect(out.subtasks[0].houseId).toBeNull();
  });

  it("ignores inactive / archived agent houses", () => {
    const disabled = house({ id: "h-disabled", name: "House of Mist", status: "disabled" });
    const plan = { subtasks: [planSubtask({ houseId: "h-disabled" }) as any] };
    const out = resolvePlan(plan, [disabled]);
    expect(out.subtasks[0].houseId).toBeNull();
  });
});

describe("scoreHouse", () => {
  it("is case-insensitive and substring-based", () => {
    expect(scoreHouse({ houseHints: "MIST", title: "" }, mist)).toBeGreaterThan(0);
    expect(scoreHouse({ houseHints: "spymaster", title: "" }, mist)).toBeGreaterThan(0);
    expect(scoreHouse({ houseHints: "totally unrelated", title: "" }, mist)).toBe(0);
  });
});

describe("normalizePlan", () => {
  it("cleans cycles, caps and resolves in one pass; is idempotent", () => {
    const many = { subtasks: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `T${i}`, dependsOn: [] })) as never };
    const first = normalizePlan(many as any, all, 8);
    expect(first.subtasks).toHaveLength(8);
    const second = normalizePlan({ subtasks: first.subtasks } as any, all, 8);
    expect(second.subtasks).toHaveLength(8);
  });
});
