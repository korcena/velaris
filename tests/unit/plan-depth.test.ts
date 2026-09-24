/**
 * Unit tests — plan-depth Kahn layering (src/components/court/plan-depth.ts).
 *
 * Covers parallel siblings sharing a depth, sequential chain layering, orphan
 * deps tolerated, and a cycle producing a bounded result (never an infinite loop).
 */

import { describe, it, expect } from "vitest";
import { computePlanDepth } from "@/components/court/plan-depth";

describe("computePlanDepth", () => {
  it("groups parallel siblings onto the same (depth 0) lane", () => {
    const nodes = [
      { id: "s0", dependsOn: [] },
      { id: "s1", dependsOn: [] },
      { id: "s2", dependsOn: [] },
    ];
    const { lanes } = computePlanDepth(nodes);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].sort()).toEqual(["s0", "s1", "s2"].sort());
  });

  it("lays a sequential chain at increasing depth", () => {
    const nodes = [
      { id: "s0", dependsOn: [] },
      { id: "s1", dependsOn: ["s0"] },
      { id: "s2", dependsOn: ["s1"] },
    ];
    const { lanes, depthById } = computePlanDepth(nodes);
    expect(lanes).toEqual([["s0"], ["s1"], ["s2"]]);
    expect(depthById.s0).toBe(0);
    expect(depthById.s1).toBe(1);
    expect(depthById.s2).toBe(2);
  });

  it("a dependent waits until all its deps are placed (diamond)", () => {
    const nodes = [
      { id: "s0", dependsOn: [] },
      { id: "s1", dependsOn: [] },
      { id: "s2", dependsOn: ["s0", "s1"] },
    ];
    const { lanes, depthById } = computePlanDepth(nodes);
    expect(lanes[0].sort()).toEqual(["s0", "s1"].sort());
    expect(depthById.s2).toBe(1);
  });

  it("tolerates orphan dep ids (treated as satisfied)", () => {
    const nodes = [
      { id: "s0", dependsOn: ["ghost"] },
      { id: "s1", dependsOn: ["s0"] },
    ];
    const { lanes, depthById } = computePlanDepth(nodes);
    // ghost isn't in the plan → s0 is depth 0.
    expect(depthById.s0).toBe(0);
    expect(depthById.s1).toBe(1);
  });

  it("handles an empty input", () => {
    expect(computePlanDepth([]).lanes).toEqual([]);
  });

  it("does not hang on a cycle (single lane, bounded)", () => {
    const nodes = [
      { id: "s0", dependsOn: ["s1"] },
      { id: "s1", dependsOn: ["s0"] },
    ];
    const { lanes, depthById } = computePlanDepth(nodes);
    // Neither can be placed → both land on a residual lane without looping.
    expect(lanes.length).toBeGreaterThan(0);
    expect(depthById.s0).toBeDefined();
    expect(depthById.s1).toBeDefined();
  });
});
