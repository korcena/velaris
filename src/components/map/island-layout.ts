/**
 * Pure, deterministic archipelago layout for the top-down map — React-free.
 *
 * Replaces the isometric `plot-layout.ts`. Each house is allocated an island:
 * the High Lord (or, when absent, the first founded house) is pinned to the
 * world heart, and the rest spiral outward in founding order (createdAt ASC,
 * id tiebreak). Satellite islands get a Fourier coastline (ported from the
 * design reference's `ISLANDS` generator) whose harmonics are seeded per
 * house, so geometry is stable between loads.
 *
 * ## Geometry (v2 — separated islands)
 *
 * The first pass placed satellites on concentric rings with a fixed radial
 * step, which packed the 12-house default world into 32 overlapping island
 * pairs (one fused landmass). v2 uses a **golden-angle phyllotaxis spiral**
 * (the classic sunflower/phyllotaxis arrangement): slot `s` is placed at
 * angle `offset + s·goldenAngle` and radius `base + step·√s`. Because
 * successive slots are ~137.5° apart while the radius grows slowly, adjacent
 * islands are always well separated, and the `√s` growth keeps them inside the
 * world for a large house count.
 *
 * ### Guarantees
 * - **Determinism:** every value derives from `WORLD_SEED`, the fixed golden
 *   angle, and `hashHouseId`; there is no `Math.random` or wall-clock read.
 * - **Append-stability:** a slot's centre, size and coastline depend only on
 *   its slot index and the fixed world — never on the total house count — so
 *   adding a house never moves an existing one.
 * - **World bounds:** satellites are clamped into the world with
 *   `EDGE_INSET` of ocean, inflated by each island's own `coastEnvelope`
 *   (the exact `1 + Σ|aₖ|` Fourier bound) so the rendered coastline also stays
 *   on canvas for every seed.
 * - **Separation:** for `0..SEPARATED_HOUSE_LIMIT` houses the islands'
 *   coastline envelopes (base ellipse × per-island `coastEnvelope`) never
 *   overlap, with an ocean margin. Past `SEPARATED_HOUSE_LIMIT` the radial
 *   clamps compress the outermost band and controlled overlap begins — geometry
 *   stays deterministic, append-stable and on-canvas, but islands in the
 *   saturated outer band may visually touch (graceful degradation, D1b).
 */

import { hashHouseId, mulberry32 } from "./random";

/** The world canvas size (px) the archipelago lives on (plan Q1). */
export const WORLD = { width: 1600, height: 1000 } as const;

/** Master seed for the archipelago (plan Q2 — the reference seed). */
export const WORLD_SEED = 2026;

/**
 * The golden angle (radians). The phyllotaxis spiral places consecutive slots
 * ~137.5° apart, which is the densest known packing for this kind of radial
 * growth and is what keeps neighbouring islands apart.
 */
export const SPIRAL_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Spiral radius (px) for the innermost satellites: `base + step·√slot`. */
export const SPIRAL_BASE_RADIUS = 380;
/** Per-√slot radial growth (px). */
export const SPIRAL_RADIUS_STEP = 70;
/** Vertical flattening — the spiral is wider than tall for the 1600×1000 world. */
export const SPIRAL_FLATTEN = 0.64;
/** Rotates the whole spiral so the first satellite is not due east. */
export const SPIRAL_ANGLE_OFFSET = 5.726;

/**
 * Base satellite ellipse radius for the innermost band (px). Reduced from 63 to
 * 59 when the coastline envelope became the sound per-island Fourier bound
 * (≈1.49–1.56 vs the old 1.32): the larger true envelopes would otherwise put
 * some inner-band islands over each other within the 0–24 separated range.
 * `tests/unit/map-island-layout.test.ts` verifies 0–24 stay overlap-free with a
 * 10px ocean margin for real-UUID-seeded islands.
 */
export const SAT_RX0 = 59;
/** Satellite radius floor once bands shrink (px). */
export const SAT_RX_MIN = 42;
/** Satellite radius shrink per radial band (px). */
export const SAT_RX_SHRINK = 4;
/** Satellite ellipse aspect (ry = rx · aspect). */
export const SAT_ASPECT = 0.6;

/** Ocean margin kept between the outermost coast and the world edge (px). */
export const EDGE_INSET = 14;

/**
 * Worst-case radial amplitude-sum bound for the **house-island** roughness range
 * (`rough ≤ 0.24`): for `islandRadius(t) = 1 + Σ aₖ·sin(kₖt + pₖ)`,
 * `|islandRadius| ≤ 1 + Σ|aₖ|`, and maximizing every draw bounds the sum by
 * `1 + Σ_{k=2..6} rough/(k−0.5) + 10·0.014 ≈ 1.562`. Earlier revisions used an
 * unverified "measured max ≈ 1.30" (1.32), which the real seeds exceed.
 *
 * Precise geometry (island world-fit, separation, label keep-out) does NOT use
 * this scalar: it derives the exact per-island bound from that island's own
 * harmonics via `coastEnvelope`, which is both sound and tighter. This constant
 * remains the documented coarse upper bound for the scene and for callers that
 * only need a scalar.
 */
export const COAST_ENVELOPE = 1.57;

/**
 * The true upper bound on an island's rendered `islandRadius` across all angles:
 * `1 + Σ|aₖ|` (since every `aₖ ≥ 0` and `|sin| ≤ 1`). Unlike a fixed scalar this
 * is exact per island, so it is sound for every seed and every roughness.
 */
export function coastEnvelope(island: Pick<Island, "harmonics">): number {
  let sum = 1;
  for (const h of island.harmonics) sum += Math.abs(h.a);
  return sum;
}

/**
 * Largest house count for which all islands are guaranteed separated.
 *
 * Up to this count the coastline envelopes are non-overlapping with at least a
 * 10px ocean margin (verified by `tests/unit/map-island-layout.test.ts`).
 * Beyond it the world is saturated: the spiral radius clamps to the world edge
 * and the outermost band necessarily overlaps (documented graceful degradation,
 * D1b) — geometry remains deterministic and append-stable, and the rendered
 * coast still never overflows the world bounds.
 */
export const SEPARATED_HOUSE_LIMIT = 24;

/** The world-heart island geometry (reference heart island, scaled to fit). */
export const HEART = { rx: 275, ry: 160, rough: 0.2, seed: 11 } as const;

/** One term of the coastline Fourier series. */
export interface FourierHarmonic {
  /** Frequency. */
  k: number;
  /** Amplitude. */
  a: number;
  /** Phase (radians). */
  p: number;
}

/** A single landmass. Decorative islets carry `slot: -1`, `houseId: null`. */
export interface Island {
  /** "heart" | `island-${slot}` | `islet-${i}`. */
  id: string;
  /** Founding slot (-1 for decorative islets). */
  slot: number;
  /** Owning house id, or null for a decorative islet. */
  houseId: string | null;
  /** Island centre, px within WORLD. */
  cx: number;
  cy: number;
  /** Ellipse base radii, px. */
  rx: number;
  ry: number;
  /** Coastline noise seed. */
  seed: number;
  /** Coastline roughness (amplitude scale). */
  rough: number;
  /** Precomputed Fourier harmonics for `islandRadius`. */
  harmonics: FourierHarmonic[];
}

/** A house placed on an island. */
export interface IslandPlot {
  houseId: string;
  /** Stable founding slot. */
  slot: number;
  /** The island the house sits on. */
  islandId: string;
  /** House centre, px within WORLD. */
  x: number;
  y: number;
  /** Size multiplier (0.85..1.15) derived from the house id. */
  sizeVariance: number;
}

/** The full deterministic layout for a set of houses. */
export interface IslandLayout {
  world: { width: number; height: number };
  /** House-bearing islands (heart + satellites); empty when there are no houses. */
  islands: Island[];
  /** Fixed decorative edge islets, independent of the house count. */
  islets: Island[];
  /** One plot per house. */
  plots: IslandPlot[];
}

/** The placement input shape (matches what `castle-map.tsx` passes). */
export interface HousePlacementInput {
  id: string;
  createdAt: string;
  kind?: string;
}

/**
 * Build the coastline Fourier harmonics for a seed/roughness, mirroring the
 * reference island generator: 5 large low-frequency waves + 10 small
 * high-frequency ripples.
 */
export function makeHarmonics(seed: number, rough: number): FourierHarmonic[] {
  const r = mulberry32(seed);
  const harmonics: FourierHarmonic[] = [];
  for (let k = 2; k <= 6; k++) {
    harmonics.push({ k, a: (rough * (0.35 + 0.65 * r())) / (k - 0.5), p: r() * Math.PI * 2 });
  }
  for (let k = 7; k <= 16; k++) {
    harmonics.push({ k, a: 0.014 * r(), p: r() * Math.PI * 2 });
  }
  return harmonics;
}

/** The radial coastline multiplier at angle `t` (1 = base ellipse). */
export function islandRadius(island: Island, t: number): number {
  let sum = 0;
  for (const h of island.harmonics) sum += h.a * Math.sin(h.k * t + h.p);
  return 1 + sum;
}

/**
 * The closed coastline path for an island, scaled by `m` (1 = coast, >1 =
 * shallows, <1 = contour). Mirrors the reference `isl.path(m)` with 160
 * segments.
 */
export function islandPath(island: Island, m = 1, segments = 160): string {
  let d = "";
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const rr = islandRadius(island, t) * m;
    const x = island.cx + island.rx * rr * Math.cos(t);
    const y = island.cy + island.ry * rr * Math.sin(t);
    d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return `${d}Z`;
}

/**
 * Whether `(x, y)` falls on any island, using the same normalised-ellipse test
 * as the reference `isl.inside`. `f` scales the coastline (1 = exact coast).
 */
export function isPointOnLand(islands: Island[], x: number, y: number, f = 1): boolean {
  return islands.some((isl) => {
    const dx = (x - isl.cx) / isl.rx;
    const dy = (y - isl.cy) / isl.ry;
    return Math.hypot(dx, dy) < islandRadius(isl, Math.atan2(dy, dx)) * f;
  });
}

/**
 * Whether two islands' rendered coastline envelopes overlap, expanded by
 * `margin` px of required ocean between them. Each ellipse is padded by that
 * island's own exact `coastEnvelope` (`1 + Σ|aₖ|`), so the test is sound for
 * every seed: if this is false the painted Fourier coastlines cannot cross
 * either.
 *
 * This is the single definition used by the layout tests and by
 * `map-labels.ts`; keeping it here (React-free) avoids duplicating the geometry.
 */
export function islandsOverlap(a: Island, b: Island, margin = 0): boolean {
  const arx = a.rx * coastEnvelope(a);
  const ary = a.ry * coastEnvelope(a);
  const brx = b.rx * coastEnvelope(b);
  const bry = b.ry * coastEnvelope(b);
  return Math.abs(a.cx - b.cx) < arx + brx + margin && Math.abs(a.cy - b.cy) < ary + bry + margin;
}

/**
 * Count the overlapping island pairs in a layout (house islands only), with
 * `margin` px of required ocean between coastline envelopes. Used by the unit
 * tests to assert the separation guarantee.
 */
export function countIslandOverlaps(layout: IslandLayout, margin = 0): number {
  let count = 0;
  for (let i = 0; i < layout.islands.length; i++) {
    for (let j = i + 1; j < layout.islands.length; j++) {
      if (islandsOverlap(layout.islands[i], layout.islands[j], margin)) count++;
    }
  }
  return count;
}

/**
 * Fixed decorative edge islets — never generated from the house count. Placed
 * in the ocean gaps between the outer spiral and the world edges so they stay
 * clear of every house island for the separated range (they are cosmetic, but
 * keeping them separate avoids re-fusing the coastlines).
 */
const ISLET_DEFS: ReadonlyArray<Omit<Island, "id" | "slot" | "houseId" | "harmonics">> = [
  { cx: 60, cy: 60, rx: 26, ry: 18, seed: 41, rough: 0.3 },
  { cx: 1540, cy: 60, rx: 26, ry: 18, seed: 42, rough: 0.3 },
  { cx: 60, cy: 940, rx: 26, ry: 18, seed: 43, rough: 0.3 },
  { cx: 1540, cy: 940, rx: 26, ry: 18, seed: 44, rough: 0.3 },
  { cx: 1120, cy: 50, rx: 30, ry: 18, seed: 45, rough: 0.28 },
  { cx: 980, cy: 950, rx: 30, ry: 18, seed: 46, rough: 0.28 },
];

function islets(): Island[] {
  return ISLET_DEFS.map((def, i) => ({
    ...def,
    id: `islet-${i}`,
    slot: -1,
    houseId: null,
    harmonics: makeHarmonics(def.seed, def.rough),
  }));
}

function buildHeartIsland(houseId: string): Island {
  return {
    id: "heart",
    slot: 0,
    houseId,
    cx: WORLD.width / 2,
    cy: WORLD.height / 2,
    rx: HEART.rx,
    ry: HEART.ry,
    seed: HEART.seed,
    rough: HEART.rough,
    harmonics: makeHarmonics(HEART.seed, HEART.rough),
  };
}

/**
 * Place a satellite on the golden-angle spiral. Position and size depend only
 * on `slot` (plus the fixed world), which is what makes the layout append-stable.
 */
function buildSatelliteIsland(houseId: string, slot: number): Island {
  // Radial band grows slowly with √slot; islands shrink a little per band so
  // the outer archipelago stays legible.
  const band = Math.floor(Math.sqrt(slot));
  const rx = Math.max(SAT_RX_MIN, SAT_RX0 - Math.max(0, band - 1) * SAT_RX_SHRINK);
  const ry = rx * SAT_ASPECT;

  const hash = hashHouseId(houseId);
  const seed = (WORLD_SEED ^ hash) >>> 0;
  const rough = 0.2 + ((hash % 3) * 0.02);
  const harmonics = makeHarmonics(seed, rough);
  // Exact, per-island Fourier bound (1 + Σ|aₖ|) — sound for every seed, and
  // tighter than the coarse `COAST_ENVELOPE` scalar.
  const envelope = coastEnvelope({ harmonics });

  // Clamp the desired spiral radius so the rendered coast (base ellipse × this
  // island's envelope) plus the ocean margin stays inside the world. Depends
  // only on the fixed world + this island's own size/harmonics, so slots are
  // stable regardless of the total house count.
  const fitX = WORLD.width / 2 - EDGE_INSET - rx * envelope;
  const fitY = (WORLD.height / 2 - EDGE_INSET - ry * envelope) / SPIRAL_FLATTEN;
  const desired = SPIRAL_BASE_RADIUS + SPIRAL_RADIUS_STEP * Math.sqrt(slot);
  const radius = Math.min(desired, fitX, fitY);

  const angle = SPIRAL_ANGLE_OFFSET + slot * SPIRAL_GOLDEN_ANGLE;
  const cx = WORLD.width / 2 + Math.cos(angle) * radius;
  const cy = WORLD.height / 2 + Math.sin(angle) * radius * SPIRAL_FLATTEN;

  return {
    id: `island-${slot}`,
    slot,
    houseId,
    cx,
    cy,
    rx,
    ry,
    seed,
    rough,
    harmonics,
  };
}

/**
 * Compute the deterministic archipelago + house placement for a set of houses.
 *
 * - Ordering: the High Lord (when present) takes slot 0 at the world heart;
 *   the remaining houses follow in founding order (createdAt ASC, id tiebreak).
 *   With no High Lord, the first founded house takes the heart.
 * - Empty input yields no islands/plots but keeps the decorative edge islets.
 * - Appending a house never changes an existing house's island or plot.
 */
export function computeIslandLayout(houses: HousePlacementInput[]): IslandLayout {
  const highLord = houses.filter((h) => h.kind === "high_lord");
  const others = houses.filter((h) => h.kind !== "high_lord");
  const sorted = [...others].sort((a, b) => {
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const ordered = highLord.length > 0 ? [...highLord, ...sorted] : sorted;

  const islands: Island[] = [];
  const plots: IslandPlot[] = ordered.map((house, slot) => {
    const island = slot === 0 ? buildHeartIsland(house.id) : buildSatelliteIsland(house.id, slot);
    islands.push(island);
    return {
      houseId: house.id,
      slot,
      islandId: island.id,
      x: Math.round(island.cx),
      y: Math.round(island.cy),
      sizeVariance: 0.85 + ((hashHouseId(house.id) % 1000) / 1000) * 0.3,
    };
  });

  return {
    world: { width: WORLD.width, height: WORLD.height },
    islands,
    islets: islets(),
    plots,
  };
}
