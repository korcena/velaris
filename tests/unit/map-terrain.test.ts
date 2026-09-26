/**
 * Unit tests for the pure seeded terrain generator
 * (src/components/map/terrain.ts).
 *
 * Covers determinism, hard particle caps, off-land star rejection, and the
 * absence of any wall-clock / `Math.random` dependence (determinism across
 * two separate calls with identical inputs is the observable proxy).
 */

import { describe, it, expect } from "vitest";
import { computeIslandLayout, isPointOnLand } from "@/components/map/island-layout";
import { generateTerrain, TERRAIN_CAPS, TERRAIN_SEED } from "@/components/map/terrain";

function house(id: string, createdAt: string, kind?: string) {
  return { id, createdAt, ...(kind ? { kind } : {}) };
}

function layoutFor(n: number) {
  const houses = Array.from({ length: n }, (_, i) =>
    house(`h-${String(i).padStart(3, "0")}`, `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`),
  );
  return computeIslandLayout(houses);
}

describe("generateTerrain", () => {
  it("is deterministic (same layout + seed → identical scene)", () => {
    const layout = layoutFor(8);
    expect(generateTerrain(layout)).toEqual(generateTerrain(layout));
  });

  it("uses TERRAIN_SEED by default", () => {
    const layout = layoutFor(4);
    expect(generateTerrain(layout, TERRAIN_SEED)).toEqual(generateTerrain(layout));
  });

  it("produces different scenes for different seeds", () => {
    const layout = layoutFor(4);
    expect(generateTerrain(layout, 1)).not.toEqual(generateTerrain(layout, 2));
  });

  it("respects the hard particle caps", () => {
    const scene = generateTerrain(layoutFor(30));
    expect(scene.stars.length).toBeLessThanOrEqual(TERRAIN_CAPS.stars);
    expect(scene.mountains.length).toBeLessThanOrEqual(TERRAIN_CAPS.mountains);
    expect(scene.trees.length).toBeLessThanOrEqual(TERRAIN_CAPS.trees);
    expect(scene.rivers.length).toBeLessThanOrEqual(TERRAIN_CAPS.rivers);
    expect(scene.rivers.length).toBe(TERRAIN_CAPS.rivers);
  });

  it("keeps every star off-land (f=1.0)", () => {
    const layout = layoutFor(12);
    const scene = generateTerrain(layout);
    const islands = [...layout.islands, ...layout.islets];
    for (const star of scene.stars) {
      expect(isPointOnLand(islands, star.x, star.y, 1.0)).toBe(false);
    }
  });

  it("builds a rectangular grid at the cap step", () => {
    const scene = generateTerrain(layoutFor(0));
    const vertical = scene.grid.filter((l) => l.x1 === l.x2);
    const horizontal = scene.grid.filter((l) => l.y1 === l.y2);
    expect(vertical.length).toBe(1600 / TERRAIN_CAPS.gridStep + 1);
    expect(horizontal.length).toBe(1000 / TERRAIN_CAPS.gridStep + 1);
  });

  it("emits coast outlines for every island, plus contours only for big islands", () => {
    const layout = layoutFor(8);
    const scene = generateTerrain(layout);
    for (const island of [...layout.islands, ...layout.islets]) {
      const coast = scene.coasts.filter((c) => c.islandId === island.id && c.kind === "coast");
      expect(coast).toHaveLength(1);
    }
    const bigIslandIds = new Set(
      [...layout.islands, ...layout.islets].filter((i) => i.rx > 100).map((i) => i.id),
    );
    for (const contour of scene.coasts.filter((c) => c.kind === "contour")) {
      expect(bigIslandIds.has(contour.islandId)).toBe(true);
    }
  });

  it("generates terrain even with no houses (islets only)", () => {
    const scene = generateTerrain(layoutFor(0));
    expect(scene.grid.length).toBeGreaterThan(0);
    expect(scene.coasts.length).toBeGreaterThan(0);
    expect(scene.stars.length).toBeGreaterThan(0);
  });

  it("returns static fog ellipse hints (no blur filters)", () => {
    const scene = generateTerrain(layoutFor(4));
    expect(scene.fog.length).toBe(3);
    for (const f of scene.fog) {
      expect(f.rx).toBeGreaterThan(0);
      expect(f.driftSeconds).toBeGreaterThan(0);
    }
  });

  it("is stable regardless of the wall clock (repeated calls equal)", async () => {
    const layout = layoutFor(6);
    const first = generateTerrain(layout);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = generateTerrain(layout);
    expect(first).toEqual(second);
  });
});
