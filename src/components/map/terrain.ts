/**
 * Pure, seeded terrain generation for the top-down archipelago map — React-free.
 *
 * Ports the reference generators (`/home/kate/Downloads/velaris-map.html`):
 * grid, sea-reflected stars (with on-land rejection + twinkle), shallows /
 * coasts / contours, mountains, forest clusters and rivers. All randomness
 * comes from `mulberry32(TERRAIN_SEED)`; there is no `Math.random` or
 * wall-clock read, so the scene is identical between server and client.
 *
 * Per plan Q4 the reference's `feGaussianBlur` glow/soft/fog filters are NOT
 * reproduced. Fog is returned as data (gradient ellipse hints) so the React
 * layer can render cheap static radial-gradient fills instead.
 *
 * Every particle family is hard-capped for performance (AGENTS.md).
 */

import { mulberry32 } from "./random";
import type { Island, IslandLayout } from "./island-layout";
import { MAP_LABELS, labelHalfExtents } from "./map-labels";

/** A faint grid line. */
export interface GridLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A star reflected in the sea. */
export interface Star {
  x: number;
  y: number;
  r: number;
  opacity: number;
  /** Set when the star twinkles; the CSS animation duration. */
  twinkleSeconds?: number;
}

/** A coastline-family outline around an island. */
export interface CoastPath {
  islandId: string;
  d: string;
  kind: "coast" | "shallow" | "contour";
  width: number;
  opacity: number;
  dash?: string;
}

/** A single mountain glyph anchor. */
export interface Mountain {
  x: number;
  y: number;
  scale: number;
}

/** A single tree glyph. */
export interface Tree {
  x: number;
  y: number;
  r: number;
}

/** A river polyline. */
export interface River {
  d: string;
}

/** A static fog ellipse hint (rendered as a radial gradient, no blur filter). */
export interface FogEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  opacity: number;
  /** Drift animation duration (seconds), for the React layer's CSS var. */
  driftSeconds: number;
  /** Reverse drift direction. */
  reverse: boolean;
}

/** The full generated terrain, as plain data. */
export interface TerrainScene {
  grid: GridLine[];
  stars: Star[];
  coasts: CoastPath[];
  mountains: Mountain[];
  trees: Tree[];
  rivers: River[];
  fog: FogEllipse[];
}

/** Hard caps on generated particles (performance guardrail). */
export const TERRAIN_CAPS = {
  stars: 260,
  mountains: 48,
  trees: 120,
  rivers: 4,
  gridStep: 200,
} as const;

/** Master terrain seed (plan Q2). */
export const TERRAIN_SEED = 2026;

/** The reference heart-island centre the fixed terrain anchors were authored against. */
const REF_HEART = { cx: 760, cy: 470 } as const;

/**
 * Fixed mountain-range control points (reference coordinates) shifted so they
 * sit over the heart island, which is always at the world centre.
 */
const MOUNTAIN_RANGES: ReadonlyArray<{
  pts: ReadonlyArray<readonly [number, number]>;
  n: number;
}> = [
  { pts: [[420, 470], [470, 540], [520, 580]], n: 12 },
  { pts: [[830, 330], [930, 360], [1030, 420], [1080, 480]], n: 16 },
  { pts: [[1330, 700], [1370, 760], [1400, 800]], n: 6 },
  { pts: [[1200, 250], [1300, 260]], n: 5 },
];

/** Fixed river heads (reference coordinates) shifted to the heart. */
const RIVER_HEADS: ReadonlyArray<{ x: number; y: number; ang: number }> = [
  { x: 700, y: 360, ang: -1.4 },
  { x: 840, y: 520, ang: 0.9 },
  { x: 480, y: 420, ang: 3.3 },
  { x: 1360, y: 620, ang: -0.2 },
];

/** Fixed fog ellipse hints (reference coordinates), shifted to the heart. */
const FOG_DEFS: ReadonlyArray<{
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  driftSeconds: number;
  reverse: boolean;
}> = [
  { cx: 500, cy: 420, rx: 320, ry: 90, driftSeconds: 90, reverse: false },
  { cx: 1150, cy: 760, rx: 360, ry: 100, driftSeconds: 120, reverse: true },
  { cx: 1100, cy: 260, rx: 260, ry: 70, driftSeconds: 90, reverse: false },
];

/**
 * Generate the deterministic terrain scene for a layout. Same layout + seed →
 * identical output. All caps in `TERRAIN_CAPS` are enforced.
 */
export function generateTerrain(layout: IslandLayout, seed = TERRAIN_SEED): TerrainScene {
  const R = mulberry32(seed);

  const allIslands: Island[] = [...layout.islands, ...layout.islets];
  const onLand = (x: number, y: number, f = 1): boolean =>
    allIslands.some((isl) => {
      const dx = (x - isl.cx) / isl.rx;
      const dy = (y - isl.cy) / isl.ry;
      let sum = 0;
      for (const h of isl.harmonics) sum += h.a * Math.sin(h.k * Math.atan2(dy, dx) + h.p);
      return Math.hypot(dx, dy) < (1 + sum) * f;
    });

  // Keep terrain clear of the house glyphs and their labels, and of the fixed
  // decorative map labels, so lettering stays legible (D2).
  const blocked = (x: number, y: number, pad = 0): boolean =>
    layout.plots.some((p) => Math.hypot(p.x - x, p.y - y) < 58 + pad) ||
    MAP_LABELS.some((label) => {
      const { hw, hh } = labelHalfExtents(label);
      return Math.abs(label.x - x) < hw + 8 + pad && Math.abs(label.y - y) < hh + 8 + pad;
    });

  // Grid (fixed; never random).
  const grid: GridLine[] = [];
  for (let x = 0; x <= layout.world.width; x += TERRAIN_CAPS.gridStep) {
    grid.push({ x1: x, y1: -400, x2: x, y2: layout.world.height + 400 });
  }
  for (let y = 0; y <= layout.world.height; y += TERRAIN_CAPS.gridStep) {
    grid.push({ x1: -600, y1: y, x2: layout.world.width + 600, y2: y });
  }

  // Stars reflected in the sea — attempt up to the cap, reject on land.
  const stars: Star[] = [];
  for (let i = 0; i < TERRAIN_CAPS.stars; i++) {
    const x = R() * 2000 - 200;
    const y = R() * 1300 - 150;
    if (onLand(x, y, 1.12)) continue;
    const star: Star = {
      x: Number(x.toFixed(1)),
      y: Number(y.toFixed(1)),
      r: Number((0.4 + R() * 1.1).toFixed(2)),
      opacity: Number((0.2 + R() * 0.5).toFixed(2)),
    };
    if (R() < 0.35) star.twinkleSeconds = 3 + R() * 5;
    stars.push(star);
  }

  // Shallows, coast and contours.
  const coasts: CoastPath[] = [];
  for (const isl of allIslands) {
    const path = (m: number): string => {
      let d = "";
      const N = 160;
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * Math.PI * 2;
        let sum = 0;
        for (const h of isl.harmonics) sum += h.a * Math.sin(h.k * t + h.p);
        const rr = (1 + sum) * m;
        const x = isl.cx + isl.rx * rr * Math.cos(t);
        const y = isl.cy + isl.ry * rr * Math.sin(t);
        d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      return `${d}Z`;
    };
    const id = isl.id;
    coasts.push(
      { islandId: id, d: path(1.0), kind: "shallow", width: 14, opacity: 0.06 },
      { islandId: id, d: path(1.07), kind: "shallow", width: 0.8, opacity: 0.28, dash: "1 4" },
      { islandId: id, d: path(1.15), kind: "shallow", width: 0.6, opacity: 0.14, dash: "1 6" },
      { islandId: id, d: path(1.0), kind: "coast", width: 1.4, opacity: 1 },
    );
    if (isl.rx > 100) {
      coasts.push({ islandId: id, d: path(0.72), kind: "contour", width: 0.7, opacity: 0.6, dash: "2 5" });
    }
    if (isl.rx > 300) {
      coasts.push({ islandId: id, d: path(0.45), kind: "contour", width: 0.7, opacity: 0.6, dash: "2 5" });
    }
  }

  // Mountain ranges along the fixed heart-island control points.
  const dx = layout.world.width / 2 - REF_HEART.cx;
  const dy = layout.world.height / 2 - REF_HEART.cy;
  const mountains: Mountain[] = [];
  const range = (pts: ReadonlyArray<readonly [number, number]>, n: number): void => {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const seg = Math.min(pts.length - 2, Math.floor(t * (pts.length - 1)));
      const lt = t * (pts.length - 1) - seg;
      const x =
        pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * lt + dx + (R() - 0.5) * 26;
      const y =
        pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * lt + dy + (R() - 0.5) * 20;
      if (onLand(x, y, 0.88) && !blocked(x, y)) {
        mountains.push({ x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), scale: 0.8 + R() * 0.7 });
      }
    }
  };
  for (const { pts, n } of MOUNTAIN_RANGES) range(pts, n);
  mountains.length = Math.min(mountains.length, TERRAIN_CAPS.mountains);

  // Forest clusters.
  const treeSpots: Array<[number, number]> = [];
  for (let c = 0; c < 26 && treeSpots.length < TERRAIN_CAPS.trees; c++) {
    let cx = 0;
    let cy = 0;
    let tries = 0;
    do {
      cx = 100 + R() * 1400;
      cy = 100 + R() * 820;
      tries++;
    } while ((!onLand(cx, cy, 0.78) || blocked(cx, cy)) && tries < 60);
    if (tries >= 60) continue;
    const n = 5 + Math.floor(R() * 8);
    for (let i = 0; i < n; i++) {
      const x = cx + (R() - 0.5) * 46;
      const y = cy + (R() - 0.5) * 34;
      if (onLand(x, y, 0.85) && !blocked(x, y, -10)) treeSpots.push([x, y]);
    }
  }
  const trees: Tree[] = treeSpots
    .slice(0, TERRAIN_CAPS.trees)
    .sort((a, b) => a[1] - b[1])
    .map(([x, y]) => ({ x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), r: Number((2.6 + R() * 2).toFixed(1)) }));

  // Rivers.
  const rivers: River[] = [];
  for (const head of RIVER_HEADS.slice(0, TERRAIN_CAPS.rivers)) {
    let x = head.x + dx;
    let y = head.y + dy;
    let ang = head.ang;
    let d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    let steps = 0;
    while (steps < 120) {
      ang += (R() - 0.5) * 0.5;
      x += Math.cos(ang) * 9;
      y += Math.sin(ang) * 9;
      d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
      if (!onLand(x, y, 0.98)) break;
      steps++;
    }
    rivers.push({ d });
  }

  const fog: FogEllipse[] = FOG_DEFS.map((f) => ({
    cx: f.cx + dx,
    cy: f.cy + dy,
    rx: f.rx,
    ry: f.ry,
    opacity: 0.06,
    driftSeconds: f.driftSeconds,
    reverse: f.reverse,
  }));

  return { grid, stars, coasts, mountains, trees, rivers, fog };
}
