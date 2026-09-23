/**
 * Unit tests for the pure map plot layout (src/components/map/plot-layout.ts).
 *
 * Semantics (outward spiral): slot 0 at the world centre, ring 1 holds 5
 * houses around it, ring n ≥ 2 holds n + 4 — the city grows outward as
 * houses are founded.
 */

import { describe, it, expect } from "vitest";
import {
  WORLD,
  hashHouseId,
  computePlotLayout,
  type CastlePlot,
} from "@/components/map/plot-layout";

function house(id: string, createdAt: string) {
  return { id, createdAt };
}

const T0 = "2024-01-01T00:00:00.000Z";
const T1 = "2024-02-01T00:00:00.000Z";
const T2 = "2024-03-01T00:00:00.000Z";

describe("hashHouseId", () => {
  it("is stable across calls", () => {
    expect(hashHouseId("abc")).toBe(hashHouseId("abc"));
  });
  it("differs for different ids", () => {
    expect(hashHouseId("abc")).not.toBe(hashHouseId("abd"));
  });
  it("is a non-negative 32-bit integer", () => {
    for (const id of ["a", "house-1", "very-long-house-id-for-testing"]) {
      const h = hashHouseId(id);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });
});

describe("computePlotLayout", () => {
  it("is deterministic (same input → same output)", () => {
    const input = [house("b", T1), house("a", T0), house("c", T2)];
    expect(computePlotLayout(input)).toEqual(computePlotLayout(input));
  });

  it("sorts houses into founding order (createdAt ASC) with id tiebreak", () => {
    // Same createdAt → id tiebreak (a before b).
    const input = [house("b", T1), house("a", T0), house("c", T2), house("d", T1)];
    const plots = computePlotLayout(input);
    expect(plots.map((p) => p.houseId)).toEqual(["a", "b", "d", "c"]);
    expect(plots.map((p) => p.slot)).toEqual([0, 1, 2, 3]);
  });

  it("assigns unique slots", () => {
    const plots = computePlotLayout([house("x", T0), house("y", T1), house("z", T2)]);
    const slots = new Set(plots.map((p) => p.slot));
    expect(slots.size).toBe(3);
  });

  it("appending a house keeps existing slots stable", () => {
    const before = computePlotLayout([house("a", T0), house("b", T1)]);
    const after = computePlotLayout([house("a", T0), house("b", T1), house("c", T2)]);
    const beforeMap = new Map(before.map((p) => [p.houseId, p]));
    for (const p of after) {
      if (p.houseId === "c") continue;
      expect(p).toEqual(beforeMap.get(p.houseId));
    }
  });

  it("places the first house at the city heart (world centre)", () => {
    const [first] = computePlotLayout([house("a", T0)]);
    expect(first.x).toBe(WORLD.width / 2);
    expect(first.y).toBe(WORLD.height / 2);
  });

  it("grows outward: ring 1 orbits the centre, ring 2 orbits ring 1", () => {
    // 1 centre + 5 ring-1 + 6 ring-2 = 12 houses.
    const houses = Array.from(
      { length: 12 },
      (_, i) => house(`h-${i}`, `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    const plots = computePlotLayout(houses);
    const distFromCentre = (p: CastlePlot) =>
      Math.hypot(p.x - WORLD.width / 2, p.y - WORLD.height / 2);

    const centre = distFromCentre(plots[0]);
    const ring1 = plots.slice(1, 6).map(distFromCentre);
    const ring2 = plots.slice(6, 12).map(distFromCentre);

    expect(centre).toBe(0);
    // Ring 1 is farther out than the centre…
    for (const d of ring1) expect(d).toBeGreaterThan(50);
    // …and ring 2 is farther out than ring 1 (radius grows with ring index).
    expect(Math.min(...ring2)).toBeGreaterThan(Math.max(...ring1));
  });

  it("staggered rings: no two houses share the same plot position", () => {
    const houses = Array.from(
      { length: 30 },
      (_, i) => house(`house-${i}`, `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`),
    );
    const plots = computePlotLayout(houses);
    const positions = new Set(plots.map((p) => `${p.x},${p.y}`));
    expect(positions.size).toBe(plots.length);
  });

  it("places all x/y strictly within WORLD bounds", () => {
    const houses = Array.from(
      { length: 40 },
      (_, i) => house(`house-${i}`, `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`),
    );
    for (const p of computePlotLayout(houses)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(WORLD.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(WORLD.height);
    }
  });

  it("keeps coordinates deterministic for large house counts", () => {
    const houses = Array.from(
      { length: 50 },
      (_, i) => house(`h${i}`, `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`),
    );
    expect(computePlotLayout(houses)).toEqual(computePlotLayout(houses));
  });

  it("produces sizeVariance within [0.8, 1.2]", () => {
    const houses = Array.from(
      { length: 30 },
      (_, i) => house(`house-${i}`, `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`),
    );
    for (const p of computePlotLayout(houses)) {
      expect(p.sizeVariance).toBeGreaterThanOrEqual(0.8);
      expect(p.sizeVariance).toBeLessThanOrEqual(1.2);
    }
  });

  it("produces windowCount within {2, 3, 4}", () => {
    const houses = Array.from(
      { length: 30 },
      (_, i) => house(`house-${i}`, `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`),
    );
    for (const p of computePlotLayout(houses)) {
      expect([2, 3, 4]).toContain(p.windowCount);
    }
  });

  it("handles an empty house list", () => {
    expect(computePlotLayout([])).toEqual([]);
  });
});