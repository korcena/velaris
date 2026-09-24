/**
 * Unit tests — plan JSON extraction & normalization (src/server/execution/planning/parse.ts).
 *
 * Covers: JSON extraction (fenced/unfenced/prose-wrapped/nested braces/invalid),
 * schema validation (valid, missing subtasks, over-cap, bad deps), cycle
 * detection + edge-drop, truncation, and the single-subtask fallback builder.
 */

import { describe, it, expect } from "vitest";
import {
  extractPlanJson,
  extractFirstBalancedObject,
  validatePlan,
  breakCycles,
  capPlan,
  buildFallbackPlan,
} from "@/server/execution/planning/parse";
import { ORCHESTRATION_DEFAULTS } from "@/shared/constants";
import type { Plan } from "@/shared/schemas/plan";

/** Full-shape Plan fixture convenience (matches planSubtaskSchema defaults). */
function plan(subtasks: Array<Record<string, unknown>>): Plan {
  return { subtasks: subtasks as never };
}

const validPlan = {
  subtasks: [
    {
      id: "s0",
      title: "Research the gate",
      dependsOn: [],
      instructions: "Investigate wards.",
    },
  ],
};

describe("extractPlanJson", () => {
  it("parses a raw JSON object", () => {
    const out = extractPlanJson(JSON.stringify(validPlan));
    expect(out).toEqual(validPlan);
  });

  it("strips a markdown json fence", () => {
    const text = "```json\n" + JSON.stringify(validPlan, null, 2) + "\n```";
    expect(extractPlanJson(text)).toEqual(validPlan);
  });

  it("strips a bare markdown fence", () => {
    const text = "```\n" + JSON.stringify(validPlan) + "\n```";
    expect(extractPlanJson(text)).toEqual(validPlan);
  });

  it("extracts JSON wrapped in prose", () => {
    const text =
      "Here is the plan:\n\n" + JSON.stringify(validPlan) + "\n\nHope that helps!";
    expect(extractPlanJson(text)).toEqual(validPlan);
  });

  it("handles nested braces and escaped quotes inside strings", () => {
    const object = {
      subtasks: [
        {
          id: "s0",
          title: 'A "quoted { brace } inside" title',
          context: { nested: { list: [{ a: 1, b: { c: "}" } }] } },
          dependsOn: [],
        },
      ],
    };
    expect(extractPlanJson(JSON.stringify(object))).toEqual(object);
  });

  it("returns null for invalid JSON inside braces", () => {
    expect(extractPlanJson("{ this is not json ]}")).toBeNull();
  });

  it("returns null for no braces / empty input", () => {
    expect(extractPlanJson("no braces here")).toBeNull();
    expect(extractPlanJson("")).toBeNull();
    expect(extractPlanJson("   ")).toBeNull();
  });
});

describe("extractFirstBalancedObject", () => {
  it("finds the first balanced object after leading text", () => {
    expect(extractFirstBalancedObject('lead {"a":1} tail')).toBe('{"a":1}');
  });
});

describe("validatePlan", () => {
  it("accepts a valid plan", () => {
    const res = validatePlan(validPlan);
    expect(res.ok).toBe(true);
    expect(res.plan?.subtasks).toHaveLength(1);
  });

  it("rejects a plan with no subtasks", () => {
    expect(validatePlan({ subtasks: [] }).ok).toBe(false);
  });

  it("rejects a plan over the cap", () => {
    const many = plan(
      Array.from({ length: ORCHESTRATION_DEFAULTS.MAX_SUBTASKS + 1 }, (_, i) => ({ id: `s${i}`, title: `T${i}`, dependsOn: [] })),
    );
    expect(validatePlan(many).ok).toBe(false);
  });

  it("rejects non-object / bad shape", () => {
    expect(validatePlan(null).ok).toBe(false);
    expect(validatePlan(42).ok).toBe(false);
    expect(validatePlan({}).ok).toBe(false);
    expect(validatePlan({ subtasks: "nope" }).ok).toBe(false);
  });
});

describe("breakCycles", () => {
  function mk(id: string, depends: string[]): Record<string, unknown> {
    return { id, title: `T-${id}`, dependsOn: depends };
  }

  it("is a no-op for a DAG", () => {
    const out = breakCycles(plan([mk("s0", []), mk("s1", ["s0"]), mk("s2", ["s0", "s1"])]));
    expect(out.subtasks.map((s) => [s.id, s.dependsOn])).toEqual([
      ["s0", []],
      ["s1", ["s0"]],
      ["s2", ["s0", "s1"]],
    ]);
  });

  it("drops unknown dep ids and self-references", () => {
    const out = breakCycles(plan([mk("s0", ["s0", "ghost"])]));
    expect(out.subtasks[0].dependsOn).toEqual([]);
  });

  it("breaks a 2-cycle by dropping one edge and keeps the plan", () => {
    const out = breakCycles(plan([mk("s0", ["s1"]), mk("s1", ["s0"])]));
    // Still two subtasks, but the graph is acyclic.
    const indeg = new Map<string, number>();
    for (const s of out.subtasks) indeg.set(s.id, 0);
    for (const s of out.subtasks) for (const d of s.dependsOn) indeg.set(d, (indeg.get(d) ?? 0) + 1);
    const roots = out.subtasks.filter((s) => (indeg.get(s.id) ?? 0) === 0);
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(out.subtasks.length).toBe(2);
  });

  it("breaks a longer cycle", () => {
    const out = breakCycles(plan([mk("s0", ["s2"]), mk("s1", ["s0"]), mk("s2", ["s1"])]));
    const indeg = new Map<string, number>();
    for (const s of out.subtasks) indeg.set(s.id, 0);
    for (const s of out.subtasks) for (const d of s.dependsOn) indeg.set(d, (indeg.get(d) ?? 0) + 1);
    const roots = out.subtasks.filter((s) => (indeg.get(s.id) ?? 0) === 0);
    expect(roots.length).toBeGreaterThanOrEqual(1);
  });
});

describe("capPlan", () => {
  it("truncates above the max and is a no-op below", () => {
    const big = plan(
      Array.from({ length: ORCHESTRATION_DEFAULTS.MAX_SUBTASKS + 3 }, (_, i) => ({ id: `s${i}`, title: `T${i}`, dependsOn: [] })),
    );
    expect(capPlan(big).subtasks).toHaveLength(ORCHESTRATION_DEFAULTS.MAX_SUBTASKS);
    expect(capPlan(plan([{ id: "s0", title: "a", dependsOn: [] }])).subtasks).toHaveLength(1);
  });
});

describe("buildFallbackPlan", () => {
  it("builds a single-subtask plan carrying title + instruction text", () => {
    const out = buildFallbackPlan({
      title: "Build a wall",
      description: "Stone wall 3m tall",
      instruction: "Build a stone wall 3m tall",
    });
    expect(out.subtasks).toHaveLength(1);
    expect(out.subtasks[0].id).toBe("s0");
    expect(out.subtasks[0].dependsOn).toEqual([]);
    expect(out.subtasks[0].instructions).toContain("Build a stone wall 3m tall");
    expect(out.subtasks[0].instructions).toContain("Stone wall 3m tall");
  });
});
