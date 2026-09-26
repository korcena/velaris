/**
 * Unit tests for the pure camera math (src/components/map/camera.ts).
 *
 * Semantics (D4 all-houses-visible fix): the default camera FITS the whole
 * world (contain scale) and centres it, so every house island is on screen from
 * the first render at common viewports. The zoom floor is the contain scale, so
 * the default camera's scale is always accepted by `clampZoom` (a scale the
 * camera returns but the clamp rejects is exactly the old crop bug).
 */

import { describe, it, expect } from "vitest";
import {
  MIN_SCALE,
  MAX_SCALE,
  ZOOM_STEP,
  clampZoom,
  coverScale,
  containScale,
  minScale,
  defaultCamera,
  visibleWorldRect,
  zoomStep,
  zoomAtPoint,
  clampPan,
  isDrag,
  type Camera,
} from "@/components/map/camera";
import {
  WORLD,
  computeIslandLayout,
  type HousePlacementInput,
} from "@/components/map/island-layout";
import { DEFAULT_HOUSES } from "@/shared/constants";

const V = { width: 1000, height: 600 };
// A viewport bigger than the world on both axes: contain > 1.
const BIG_V = { width: 2000, height: 1600 };
const identity = (c: Camera): Camera => ({ x: c.x, y: c.y, scale: c.scale });

/**
 * The real 12-house world: an earlier user house + the seeded High Lord + the
 * ten default houses (mirrors the orchestrator's measurement fixture). Ordering
 * inside `computeIslandLayout` is by kind/createdAt, so this is the actual
 * geometry rendered on load.
 */
function realTwelveHouses(): HousePlacementInput[] {
  const defaults = DEFAULT_HOUSES.map((_, i) => ({
    id: `default-${String(i).padStart(2, "0")}`,
    createdAt: "2026-09-26T00:55:00.115Z",
    kind: "agent",
  }));
  return [
    { id: "user-house", createdAt: "2026-09-22T23:10:17.321Z", kind: "agent" },
    { id: "high-lord", createdAt: "2026-09-24T12:30:56.342Z", kind: "high_lord" },
    ...defaults,
  ];
}

// The measured map-panel sizes at the three supported browser viewports.
// 1280×720 → 960×664; 1440×900 → 1120×844; 1920×1080 → 1600×1024.
const COMMON_VIEWPORTS = [
  { browser: "1280×720", panel: { width: 960, height: 664 } },
  { browser: "1440×900", panel: { width: 1120, height: 844 } },
  { browser: "1920×1080", panel: { width: 1600, height: 1024 } },
] as const;

describe("coverScale / containScale / minScale", () => {
  it("coverScale = max(viewport/world) per axis", () => {
    // 2000/1600 = 1.25 < 1600/1000 = 1.6 → 1.6.
    expect(coverScale(BIG_V, WORLD)).toBeCloseTo(Math.max(2000 / 1600, 1600 / 1000), 5);
    expect(coverScale(V, WORLD)).toBeCloseTo(Math.max(1000 / 1600, 600 / 1000), 5);
  });

  it("containScale = min(viewport/world) per axis (whole world fits)", () => {
    // 2000/1600 = 1.25, 1600/1000 = 1.6 → 1.25, and the scaled world fits.
    expect(containScale(BIG_V, WORLD)).toBeCloseTo(Math.min(2000 / 1600, 1600 / 1000), 5);
    expect(WORLD.width * containScale(BIG_V, WORLD)).toBeLessThanOrEqual(BIG_V.width);
    expect(WORLD.height * containScale(BIG_V, WORLD)).toBeLessThanOrEqual(BIG_V.height);
  });

  it("minScale is the contain floor and never exceeds it (default is accepted)", () => {
    expect(minScale(V, WORLD)).toBeCloseTo(containScale(V, WORLD), 5);
    // The floor can never sit above the fit scale, so `clampZoom` never clamps
    // the default camera's own scale back into a crop.
    expect(minScale(BIG_V, WORLD)).toBeLessThanOrEqual(containScale(BIG_V, WORLD));
    expect(clampZoom(containScale(BIG_V, WORLD), BIG_V, WORLD)).toBeCloseTo(
      containScale(BIG_V, WORLD),
      5,
    );
  });
});

describe("clampZoom", () => {
  it("clamps at absolute min and max without viewport context", () => {
    expect(clampZoom(0.1)).toBe(MIN_SCALE);
    expect(clampZoom(999)).toBe(MAX_SCALE);
  });
  it("clamps at the dynamic contain floor", () => {
    const floor = minScale(BIG_V, WORLD);
    expect(floor).toBeGreaterThan(1);
    expect(clampZoom(0.5, BIG_V, WORLD)).toBeCloseTo(floor, 5);
    expect(clampZoom(999, BIG_V, WORLD)).toBe(MAX_SCALE);
  });
  it("passes through in-range values, including the default scale", () => {
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(MAX_SCALE, V, WORLD)).toBe(MAX_SCALE);
    // The default scale is never clamped (the D4 invariant).
    const scale = defaultCamera(V, WORLD).scale;
    expect(clampZoom(scale, V, WORLD)).toBeCloseTo(scale, 5);
  });
});

describe("defaultCamera — all houses visible (D4)", () => {
  it("uses the contain scale and centres the world", () => {
    const cam = defaultCamera(BIG_V, WORLD);
    expect(cam.scale).toBeCloseTo(containScale(BIG_V, WORLD), 5);
    const Wx = WORLD.width * cam.scale;
    const Wy = WORLD.height * cam.scale;
    expect(Wx).toBeLessThanOrEqual(BIG_V.width);
    expect(Wy).toBeLessThanOrEqual(BIG_V.height);
    expect(cam.x).toBeCloseTo((BIG_V.width - Wx) / 2, 3);
    expect(cam.y).toBeCloseTo((BIG_V.height - Wy) / 2, 3);
  });

  it("returns a scale that clampZoom accepts, at every common viewport", () => {
    for (const { browser, panel } of COMMON_VIEWPORTS) {
      const cam = defaultCamera(panel, WORLD);
      expect(clampZoom(cam.scale, panel, WORLD), browser).toBeCloseTo(cam.scale, 6);
    }
    // Also at the world-fitting viewport, where contain is 1 (not the old cover
    // 1.024 crop).
    const wide = { width: 1920, height: 1200 };
    const cam = defaultCamera(wide, WORLD);
    expect(clampZoom(cam.scale, wide, WORLD)).toBeCloseTo(cam.scale, 6);
  });

  it("shows every house plot in the visible world rect at 1280×720, 1440×900, 1920×1080", () => {
    const layout = computeIslandLayout(realTwelveHouses());
    expect(layout.plots).toHaveLength(12);

    for (const { browser, panel } of COMMON_VIEWPORTS) {
      const cam = defaultCamera(panel, WORLD);
      const rect = visibleWorldRect(cam, panel);
      for (const plot of layout.plots) {
        // Glyph centre on screen.
        expect(rect.x0, `${browser}: ${plot.houseId} left`).toBeLessThanOrEqual(plot.x);
        expect(rect.x1, `${browser}: ${plot.houseId} right`).toBeGreaterThanOrEqual(plot.x);
        expect(rect.y0, `${browser}: ${plot.houseId} top`).toBeLessThanOrEqual(plot.y);
        expect(rect.y1, `${browser}: ${plot.houseId} bottom`).toBeGreaterThanOrEqual(plot.y);
        // The name/role label band (y+30..y+74) must also be inside, so a label
        // is never half-cut at the viewport edge.
        const labelPad = 80;
        expect(rect.x0, `${browser}: ${plot.houseId} label left`).toBeLessThanOrEqual(plot.x - labelPad);
        expect(rect.x1, `${browser}: ${plot.houseId} label right`).toBeGreaterThanOrEqual(plot.x + labelPad);
        expect(rect.y1, `${browser}: ${plot.houseId} label bottom`).toBeGreaterThanOrEqual(plot.y + 74);
        expect(rect.y0, `${browser}: ${plot.houseId} label top`).toBeLessThanOrEqual(plot.y - 34);
      }
    }
  });

  it("at 1280×720 the whole 1600×1000 world fits in the 960×664 panel (contain 0.6)", () => {
    const panel = { width: 960, height: 664 };
    const cam = defaultCamera(panel, WORLD);
    expect(cam.scale).toBeCloseTo(0.6, 6);
    const rect = visibleWorldRect(cam, panel);
    expect(rect.x0).toBeLessThanOrEqual(0);
    expect(rect.x1).toBeGreaterThanOrEqual(WORLD.width);
    expect(rect.y0).toBeLessThanOrEqual(0);
    expect(rect.y1).toBeGreaterThanOrEqual(WORLD.height);
  });
});

describe("zoomStep", () => {
  it("zooms in ×1.1 in range", () => {
    const start = defaultCamera(V, WORLD);
    const result = zoomStep(start, 1, V);
    expect(result.scale).toBeCloseTo(start.scale * ZOOM_STEP, 5);
  });
  it("zooms out ÷1.1 until the contain floor stops it", () => {
    const start: Camera = { ...defaultCamera(V, WORLD), scale: 1 };
    const result = zoomStep(start, -1, V);
    expect(result.scale).toBeCloseTo(1 / ZOOM_STEP, 5);
  });
  it("clamps at max scale", () => {
    const start: Camera = { ...defaultCamera(V, WORLD), scale: MAX_SCALE };
    expect(zoomStep(start, 1, V).scale).toBe(MAX_SCALE);
  });
  it("cannot zoom out past the contain floor", () => {
    const start = defaultCamera(BIG_V, WORLD);
    const result = zoomStep(start, -1, BIG_V);
    expect(result.scale).toBeCloseTo(minScale(BIG_V, WORLD), 5);
  });
});

describe("zoomAtPoint", () => {
  it("keeps the world point under the cursor invariant", () => {
    const cursor = { x: 700, y: 220 };
    const camera: Camera = { x: -150, y: -80, scale: 1.4 };
    const before = {
      x: (cursor.x - camera.x) / camera.scale,
      y: (cursor.y - camera.y) / camera.scale,
    };
    const afterCam = zoomAtPoint(camera, cursor, 1.1, V);
    const after = {
      x: (cursor.x - afterCam.x) / afterCam.scale,
      y: (cursor.y - afterCam.y) / afterCam.scale,
    };
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
  });

  it("applies the clamp on scale", () => {
    const cursor = { x: 500, y: 300 };
    const atMax: Camera = { x: -140, y: -100, scale: MAX_SCALE };
    expect(zoomAtPoint(atMax, cursor, 1.1, V).scale).toBe(MAX_SCALE);
    const atFloor: Camera = { ...defaultCamera(BIG_V, WORLD) };
    expect(zoomAtPoint(atFloor, cursor, 1 / 1.1, BIG_V).scale).toBeCloseTo(
      minScale(BIG_V, WORLD),
      5,
    );
  });

  it("at the floor the whole world stays visible (never crops)", () => {
    let cam = defaultCamera(BIG_V, WORLD);
    for (let i = 0; i < 40; i++) {
      cam = zoomAtPoint(cam, { x: 1000, y: 800 }, 1 / ZOOM_STEP, BIG_V, WORLD);
    }
    expect(cam.scale).toBeCloseTo(minScale(BIG_V, WORLD), 5);
    // The scaled world fits entirely inside the viewport.
    expect(WORLD.width * cam.scale).toBeLessThanOrEqual(BIG_V.width);
    expect(WORLD.height * cam.scale).toBeLessThanOrEqual(BIG_V.height);
  });
});

describe("clampPan", () => {
  it("W > viewport: leaves EDGE_MARGIN of terrain visible on both edges (x)", () => {
    // At scale 2, world x extent = 1600*2 = 3200 > 1000 viewport.
    const extremeLeft: Camera = { x: -5000, y: -5000, scale: 2 };
    const clamped = clampPan(extremeLeft, V);
    // world scaled width W=3200; lower = max(M-W, V-W) = max(60-3200, 1000-3200) = -2200
    // upper = min(V-M,0) = min(940,0) = 0
    expect(clamped.x).toBe(-2200);
    // World visible on the right edge: W + x = 3200 - 2200 = 1000 = V (EDGE_MARGIN to the left).
    expect(WORLD.width * clamped.scale + clamped.x).toBeCloseTo(V.width, 3);
  });

  it("W ≤ viewport: world is centred (letterbox margins equal)", () => {
    // At scale 0.5, world x extent = 1600*0.5 = 800 < 1000 viewport.
    const pan = clampPan({ ...identity(defaultCamera(V, WORLD)), scale: MIN_SCALE }, V);
    expect(pan.x).toBeCloseTo((V.width - WORLD.width * MIN_SCALE) / 2, 3);
    // Vertical axis: world 1000*0.5=500 < 600 → centred y = (600-500)/2 = 50.
    expect(pan.y).toBeCloseTo((V.height - WORLD.height * MIN_SCALE) / 2, 3);
  });

  it("the default camera is already legal when the world fits (centred)", () => {
    const cam = defaultCamera(V, WORLD);
    const clamped = clampPan(cam, V);
    expect(clamped).toEqual(cam);
  });

  it("the default camera is already legal when the world covers the viewport", () => {
    // A viewport smaller than the world at the default scale: still centred.
    const small = { width: 400, height: 300 };
    const cam = defaultCamera(small, WORLD);
    const clamped = clampPan(cam, small);
    expect(clamped).toEqual(cam);
  });
});

describe("isDrag", () => {
  it("5px exactly → false", () => {
    expect(isDrag({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(false);
  });
  it("slightly over 5px → true", () => {
    expect(isDrag({ x: 0, y: 0 }, { x: 5.01, y: 0 })).toBe(true);
  });
  it("(3,4) triangle has hypot 5 → false; custom threshold makes it true", () => {
    expect(isDrag({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(false);
    expect(isDrag({ x: 0, y: 0 }, { x: 3, y: 4 }, 4)).toBe(true);
  });
  it("zero movement → false", () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
  });
});
