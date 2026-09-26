/**
 * Unit tests for the pure archipelago layout
 * (src/components/map/island-layout.ts).
 *
 * Semantics: the High Lord (or the first founded house when absent) is pinned
 * to the world heart; the rest spiral outward in founding order. Geometry is
 * deterministic and append-stable.
 */

import { describe, it, expect } from "vitest";
import {
  WORLD,
  WORLD_SEED,
  HEART,
  COAST_ENVELOPE,
  coastEnvelope,
  SEPARATED_HOUSE_LIMIT,
  computeIslandLayout,
  countIslandOverlaps,
  islandPath,
  islandRadius,
  isPointOnLand,
  makeHarmonics,
  type Island,
  type IslandLayout,
} from "@/components/map/island-layout";
import { hashHouseId } from "@/components/map/random";

function house(id: string, createdAt: string, kind?: string) {
  return { id, createdAt, ...(kind ? { kind } : {}) };
}

const T0 = "2024-01-01T00:00:00.000Z";
const T1 = "2024-02-01T00:00:00.000Z";
const T2 = "2024-03-01T00:00:00.000Z";
const T3 = "2024-04-01T00:00:00.000Z";

/** N houses with strictly increasing createdAt so founding order is stable. */
function many(n: number) {
  return Array.from({ length: n }, (_, i) =>
    house(`house-${String(i).padStart(3, "0")}`, `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`),
  );
}

/**
 * Deterministic UUID strings (v4-shaped). The M3 review found that only
 * low-amplitude synthetic ids were exercised, so the sound-envelope checks must
 * also run against realistic (UUID-seeded) islands. A seeded PRNG keeps the test
 * deterministic while producing real-UUID hash distributions.
 */
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function uuidStrings(n: number, seed = 0x5eed): string[] {
  const rng = mulberry32(seed);
  const hex = "0123456789abcdef";
  return Array.from({ length: n }, () => {
    let s = "";
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) s += "-";
      else if (i === 14) s += "4";
      else if (i === 19) s += hex[(Math.floor(rng() * 4) + 8) % 16];
      else s += hex[Math.floor(rng() * 16)];
    }
    return s;
  });
}
/** N real-UUID houses in stable founding order (first is the High Lord). */
function manyReal(n: number) {
  return uuidStrings(n).map((id, i) =>
    house(id, `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, i === 0 ? "high_lord" : "agent"),
  );
}

/** True if the island's exact rendered coastline envelope stays inside WORLD. */
function envelopeInsideWorld(island: Island): boolean {
  const envelope = coastEnvelope(island);
  const rx = island.rx * envelope;
  const ry = island.ry * envelope;
  return (
    island.cx - rx >= 0 &&
    island.cx + rx <= WORLD.width &&
    island.cy - ry >= 0 &&
    island.cy + ry <= WORLD.height
  );
}

describe("world constants", () => {
  it("is the planned 1600×1000 world with seed 2026", () => {
    expect(WORLD).toEqual({ width: 1600, height: 1000 });
    expect(WORLD_SEED).toBe(2026);
  });
});

describe("makeHarmonics / islandRadius", () => {
  it("is deterministic and builds 15 harmonics", () => {
    const a = makeHarmonics(11, 0.2);
    const b = makeHarmonics(11, 0.2);
    expect(a).toEqual(b);
    expect(a).toHaveLength(15);
  });

  it("is bounded around the base ellipse for the reference roughness", () => {
    const island = {
      id: "x", slot: 1, houseId: "h", cx: 0, cy: 0, rx: 100, ry: 70, seed: 11, rough: 0.2,
      harmonics: makeHarmonics(11, 0.2),
    };
    for (let i = 0; i < 100; i++) {
      const r = islandRadius(island, (i / 100) * Math.PI * 2);
      expect(Math.abs(r - 1)).toBeLessThan(0.25);
    }
  });

  it("never lets the sampled radius exceed the per-island coastEnvelope (M3)", () => {
    // `coastEnvelope = 1 + Σ|aₖ|` is the true upper bound on `islandRadius`
    // across all angles (|sin| ≤ 1). Verify it at sampled angles for
    // real-UUID-seeded islands, including the high-roughness class the old
    // `1.32` scalar under-bounded.
    for (const id of uuidStrings(200, 0xa11ce)) {
      const hash = hashHouseId(id);
      const rough = 0.2 + ((hash % 3) * 0.02);
      const harmonics = makeHarmonics((WORLD_SEED ^ hash) >>> 0, rough);
      const island = { id, slot: 1, houseId: id, cx: 0, cy: 0, rx: 100, ry: 60, seed: 1, rough, harmonics };
      const envelope = coastEnvelope(island);
      for (let i = 0; i < 360; i++) {
        expect(islandRadius(island, (i / 360) * Math.PI * 2), id).toBeLessThanOrEqual(envelope + 1e-9);
      }
      // And the documented coarse scalar is itself a sound upper bound.
      expect(envelope, id).toBeLessThanOrEqual(COAST_ENVELOPE + 1e-9);
    }
  });
});

describe("computeIslandLayout", () => {
  it("is deterministic (same input → identical output)", () => {
    const input = [house("b", T1), house("a", T0), house("c", T2)];
    expect(computeIslandLayout(input)).toEqual(computeIslandLayout(input));
  });

  it("sorts houses into founding order (createdAt ASC) with id tiebreak", () => {
    const input = [house("b", T1), house("a", T0), house("c", T2), house("d", T1)];
    const layout = computeIslandLayout(input);
    expect(layout.plots.map((p) => p.houseId)).toEqual(["a", "b", "d", "c"]);
    expect(layout.plots.map((p) => p.slot)).toEqual([0, 1, 2, 3]);
  });

  it("pins the High Lord at the world heart (slot 0) even when not oldest", () => {
    const input = [
      house("agent-a", T0, "agent"),
      house("high-lord", T1, "high_lord"),
      house("agent-b", T2, "agent"),
    ];
    const layout = computeIslandLayout(input);
    const hl = layout.plots.find((p) => p.houseId === "high-lord")!;
    expect(hl.slot).toBe(0);
    expect(hl.x).toBe(WORLD.width / 2);
    expect(hl.y).toBe(WORLD.height / 2);
    expect(layout.plots[0].houseId).toBe("high-lord");
    expect(layout.islands[0].id).toBe("heart");
    expect(layout.islands[0].houseId).toBe("high-lord");
    // The heart island carries the reference geometry.
    expect(layout.islands[0].rx).toBe(HEART.rx);
    expect(layout.islands[0].ry).toBe(HEART.ry);
  });

  it("pins the High Lord to the centre regardless of founded position", () => {
    const layout = computeIslandLayout([
      house("hl", T2, "high_lord"),
      house("agent-a", T0),
      house("agent-b", T1),
    ]);
    expect(layout.plots[0].houseId).toBe("hl");
    expect(layout.plots[0].x).toBe(WORLD.width / 2);
    expect(layout.plots[0].y).toBe(WORLD.height / 2);
    expect(layout.plots.map((p) => p.houseId)).toEqual(["hl", "agent-a", "agent-b"]);
  });

  it("places the first founded house at the heart when there is no High Lord", () => {
    const layout = computeIslandLayout([house("c", T2), house("a", T0), house("b", T1)]);
    expect(layout.plots.map((p) => p.houseId)).toEqual(["a", "b", "c"]);
    expect(layout.plots[0].x).toBe(WORLD.width / 2);
    expect(layout.plots[0].y).toBe(WORLD.height / 2);
    expect(layout.islands[0].id).toBe("heart");
  });

  it("appending a house leaves existing islands and plots untouched", () => {
    const before = computeIslandLayout([house("a", T0), house("b", T1)]);
    const after = computeIslandLayout([house("a", T0), house("b", T1), house("c", T2)]);
    const beforePlots = new Map(before.plots.map((p) => [p.houseId, p]));
    const beforeIslands = new Map(before.islands.map((island) => [island.id, island]));
    for (const p of after.plots) {
      if (p.houseId === "c") continue;
      expect(p).toEqual(beforePlots.get(p.houseId));
    }
    for (const island of after.islands) {
      if (island.houseId === "c") continue;
      expect(island).toEqual(beforeIslands.get(island.id));
    }
    // Decorative islets never depend on N either.
    expect(after.islets).toEqual(before.islets);
  });

  it("appending a house keeps slots stable with the High Lord pinned at 0", () => {
    const before = computeIslandLayout([
      house("agent-a", T0),
      house("hl", T1, "high_lord"),
      house("agent-b", T2),
    ]);
    const after = computeIslandLayout([
      house("agent-a", T0),
      house("hl", T1, "high_lord"),
      house("agent-b", T2),
      house("agent-c", T3),
    ]);
    const beforeMap = new Map(before.plots.map((p) => [p.houseId, p]));
    for (const p of after.plots) {
      if (p.houseId === "agent-c") continue;
      expect(p).toEqual(beforeMap.get(p.houseId)!);
    }
    expect(after.plots[0].houseId).toBe("hl");
    expect(after.plots.map((p) => p.slot)).toEqual([0, 1, 2, 3]);
  });

  it("returns no islands/plots but keeps islets for an empty house list", () => {
    const layout = computeIslandLayout([]);
    expect(layout.islands).toEqual([]);
    expect(layout.plots).toEqual([]);
    expect(layout.islets.length).toBeGreaterThan(0);
    // Islets are decorative and independent of the house count.
    expect(layout.islets.every((i) => i.slot === -1 && i.houseId === null)).toBe(true);
  });

  it("places a single house at the heart", () => {
    const layout = computeIslandLayout([house("solo", T0)]);
    expect(layout.plots).toHaveLength(1);
    expect(layout.islands).toHaveLength(1);
    expect(layout.plots[0].x).toBe(WORLD.width / 2);
    expect(layout.plots[0].y).toBe(WORLD.height / 2);
  });

  it("assigns unique slots and unique island ids", () => {
    const layout = computeIslandLayout(many(30));
    expect(new Set(layout.plots.map((p) => p.slot)).size).toBe(30);
    expect(new Set(layout.islands.map((i) => i.id)).size).toBe(30);
  });

  it("has no two houses share the same plot position for 30 houses", () => {
    const layout = computeIslandLayout(many(30));
    const positions = new Set(layout.plots.map((p) => `${p.x},${p.y}`));
    expect(positions.size).toBe(layout.plots.length);
  });

  it.each([0, 1, 2, 7, 30, 60])("keeps every island centre inside WORLD for N=%i", (n) => {
    const layout = computeIslandLayout(many(n));
    for (const island of [...layout.islands, ...layout.islets]) {
      expect(island.cx).toBeGreaterThanOrEqual(0);
      expect(island.cx).toBeLessThan(WORLD.width);
      expect(island.cy).toBeGreaterThanOrEqual(0);
      expect(island.cy).toBeLessThan(WORLD.height);
    }
    for (const p of layout.plots) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(WORLD.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(WORLD.height);
    }
  });

  it("is deterministic for large house counts", () => {
    expect(computeIslandLayout(many(60))).toEqual(computeIslandLayout(many(60)));
  });

  it("produces sizeVariance within [0.85, 1.15]", () => {
    for (const p of computeIslandLayout(many(30)).plots) {
      expect(p.sizeVariance).toBeGreaterThanOrEqual(0.85);
      expect(p.sizeVariance).toBeLessThanOrEqual(1.15);
    }
  });

  it("allocates satellites in founding order (spiralling outward)", () => {
    const layout = computeIslandLayout(many(7));
    const dist = (p: { x: number; y: number }) => Math.hypot(p.x - WORLD.width / 2, p.y - WORLD.height / 2);
    expect(dist(layout.plots[0])).toBe(0);
    for (const p of layout.plots.slice(1)) expect(dist(p)).toBeGreaterThan(50);
  });
});

describe("island separation (D1)", () => {
  it("has zero overlapping island pairs for 0–20 houses (with ocean margin)", () => {
    for (let n = 0; n <= 20; n++) {
      const layout = computeIslandLayout(many(n));
      expect(countIslandOverlaps(layout, 10)).toBe(0);
    }
  });

  it("keeps the documented separated range overlap-free for every N up to the limit", () => {
    // SEPARATED_HOUSE_LIMIT is the documented guarantee; assert it rather than
    // a magic number so the constant and the behaviour cannot drift apart.
    expect(SEPARATED_HOUSE_LIMIT).toBeGreaterThanOrEqual(20);
    for (let n = 0; n <= SEPARATED_HOUSE_LIMIT; n++) {
      const layout = computeIslandLayout(many(n));
      expect(countIslandOverlaps(layout, 10)).toBe(0);
    }
  });

  it("keeps every coastline envelope inside WORLD for large N", () => {
    for (const n of [0, 1, 12, 20, 30, 60, 90]) {
      const layout = computeIslandLayout(many(n));
      for (const island of layout.islands) {
        expect(envelopeInsideWorld(island)).toBe(true);
      }
    }
  });

  it("degrades gracefully past the limit (bounded overlap, still deterministic)", () => {
    // Past SEPARATED_HOUSE_LIMIT the world is saturated: a few outer-band
    // pairs may overlap, but the count stays small relative to the pair count,
    // every island remains on-canvas, and the layout is still deterministic.
    const n = SEPARATED_HOUSE_LIMIT + 16;
    const layout = computeIslandLayout(many(n));
    const pairs = (n * (n - 1)) / 2;
    const overlaps = countIslandOverlaps(layout, 0);
    expect(overlaps).toBeGreaterThan(0);
    expect(overlaps).toBeLessThan(pairs * 0.25);
    for (const island of layout.islands) expect(envelopeInsideWorld(island)).toBe(true);
    expect(computeIslandLayout(many(n))).toEqual(layout);
  });

  it("keeps the heart and satellites separated even at 24 houses (real geometry)", () => {
    // The D1 regression case: 12 houses produced 32 overlapping pairs; after
    // the spiral rewrite the default 12-house world must have none.
    const layout = computeIslandLayout([
      house("high-lord", T0, "high_lord"),
      ...many(11),
    ]);
    expect(countIslandOverlaps(layout, 0)).toBe(0);
    expect(countIslandOverlaps(layout, 10)).toBe(0);
  });

  it("stays overlap-free for REAL-UUID-seeded islands up to the limit (M3)", () => {
    // The M3 review: the separation bound was only validated against
    // low-amplitude synthetic ids. UUID-seeded islands carry the full Fourier
    // amplitude range, so assert the sound per-island envelope holds for them.
    for (let n = 0; n <= SEPARATED_HOUSE_LIMIT; n++) {
      const layout = computeIslandLayout(manyReal(n));
      expect(countIslandOverlaps(layout, 10), `N=${n}`).toBe(0);
      for (const island of layout.islands) {
        expect(envelopeInsideWorld(island), `bounds ${island.id} at N=${n}`).toBe(true);
      }
    }
  });

  it("bounds the exact envelope by the documented COAST_ENVELOPE scalar", () => {
    // `COAST_ENVELOPE` is the coarse documented upper bound; each island's
    // exact `coastEnvelope` must never exceed it for the house-island range.
    for (const n of [1, 12, 24]) {
      for (const island of computeIslandLayout(manyReal(n)).islands) {
        expect(coastEnvelope(island), island.id).toBeLessThanOrEqual(COAST_ENVELOPE);
        expect(coastEnvelope(island), island.id).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe("islandPath / islandRadius / isPointOnLand", () => {
  const layout: IslandLayout = computeIslandLayout([house("a", T0)]);
  const heart = layout.islands[0];

  it("islandPath starts with M, ends with Z, and has 160 segments", () => {
    const d = islandPath(heart);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect((d.match(/L/g) ?? []).length).toBe(160);
  });

  it("islandPath is deterministic and scales with m", () => {
    expect(islandPath(heart, 1.07)).toBe(islandPath(heart, 1.07));
    expect(islandPath(heart, 1.15)).not.toBe(islandPath(heart, 1));
  });

  it("isPointOnLand is true at an island centre and false far offshore", () => {
    for (const island of layout.islands) {
      expect(isPointOnLand(layout.islands, island.cx, island.cy)).toBe(true);
    }
    expect(isPointOnLand(layout.islands, -400, -400, 1)).toBe(false);
  });
});
