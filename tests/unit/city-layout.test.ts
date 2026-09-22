/**
 * U2 — unit tests for the pure city layout (src/components/city/layout.ts).
 */

import { describe, it, expect } from "vitest";
import {
  hashHouseId,
  computeCityLayout,
  type CityPlot,
} from "@/components/city/layout";

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

describe("computeCityLayout", () => {
  it("is deterministic (same input → same output)", () => {
    const input = [house("b", T1), house("a", T0), house("c", T2)];
    expect(computeCityLayout(input)).toEqual(computeCityLayout(input));
  });

  it("sorts houses into founding order (createdAt ASC)", () => {
    const input = [house("b", T1), house("a", T0), house("c", T2)];
    const plots = computeCityLayout(input);
    expect(plots.map((p) => p.houseId)).toEqual(["a", "b", "c"]);
    expect(plots.map((p) => p.slot)).toEqual([0, 1, 2]);
  });

  it("assigns unique slots", () => {
    const plots = computeCityLayout([house("x", T0), house("y", T1), house("z", T2)]);
    const slots = new Set(plots.map((p) => p.slot));
    expect(slots.size).toBe(3);
  });

  it("appending a house keeps existing slots stable", () => {
    const before = computeCityLayout([house("a", T0), house("b", T1)]);
    const after = computeCityLayout([house("a", T0), house("b", T1), house("c", T2)]);
    const beforeMap = new Map(before.map((p) => [p.houseId, p]));
    for (const p of after) {
      if (p.houseId === "c") continue;
      expect(p).toEqual(beforeMap.get(p.houseId));
    }
  });

  it("wraps a second row for more than `columns` houses", () => {
    const houses = Array.from({ length: 7 }, (_, i) => house(`h-${i}`, `2024-01-0${i + 1}T00:00:00.000Z`));
    const plots = computeCityLayout(houses, { columns: 5 });
    // 7 houses, 5 columns → rows of 5 and 2.
    expect(plots).toHaveLength(7);
    const firstRow = plots.filter((p) => p.slot < 5);
    const secondRow = plots.filter((p) => p.slot >= 5);
    // Second row sits higher (smaller y = further away / up).
    expect(Math.max(...secondRow.map((p) => p.y))).toBeLessThan(
      Math.min(...firstRow.map((p) => p.y)) + 1,
    );
  });

  it("keeps x within the 0..100 band and wraps at column boundaries", () => {
    const houses = Array.from({ length: 6 }, (_, i) => house(`h${i}`, `2024-01-0${i + 1}T00:00:00.000Z`));
    const plots = computeCityLayout(houses);
    const band = 100 / 5;
    for (const p of plots) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(100);
      const expectedCol = p.slot % 5;
      expect(p.x).toBeCloseTo(band * expectedCol + band / 2, 5);
    }
  });

  it("produces variant values within allowed ranges", () => {
    const houses = Array.from({ length: 20 }, (_, i) => house(`house-${i}`, `2024-01-01T00:00:0${i}Z`));
    for (const p of computeCityLayout(houses)) {
      expect(p.heightVariance).toBeGreaterThanOrEqual(0.6);
      expect(p.heightVariance).toBeLessThanOrEqual(1.4);
      expect([0, 1, 2]).toContain(p.roofVariant);
      expect([0, 1, 2]).toContain(p.tintVariant);
    }
  });

  it("falls back to 5 columns when opts.columns is invalid", () => {
    const plots = computeCityLayout([house("a", T0), house("b", T1), house("c", T2)], { columns: 0 });
    expect(plots).toHaveLength(3);
    expect(plots[0].slot).toBe(0);
  });

  it("handles an empty house list", () => {
    expect(computeCityLayout([])).toEqual([]);
  });
});
