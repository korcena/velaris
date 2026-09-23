/**
 * Unit tests for the pure camera math (src/components/map/camera.ts).
 *
 * Semantics (Phase 3.1 terrain-coverage fix): the zoom floor is dynamic —
 * `minScale(viewport, world)` = max(MIN_SCALE, coverScale) — so the world can
 * never zoom out past the point where it stops covering the viewport.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCALE,
  MIN_SCALE,
  MAX_SCALE,
  ZOOM_STEP,
  clampZoom,
  coverScale,
  minScale,
  defaultCamera,
  zoomStep,
  zoomAtPoint,
  clampPan,
  isDrag,
  type Camera,
} from "@/components/map/camera";
import { WORLD } from "@/components/map/plot-layout";

const V = { width: 1000, height: 600 };
// A big viewport: wider AND taller than the world — cover scale > 1.
const BIG_V = { width: 2000, height: 1600 };
const identity = (c: Camera): Camera => ({ x: c.x, y: c.y, scale: c.scale });

describe("coverScale / minScale", () => {
  it("coverScale = max(viewport/world) per axis", () => {
    // 2000/1280 = 1.5625 > 1600/800 = 2 → wait, 1600/800 = 2 > 1.5625 → 2.
    expect(coverScale(BIG_V, WORLD)).toBeCloseTo(Math.max(2000 / 1280, 1600 / 800), 5);
    expect(coverScale(V, WORLD)).toBeCloseTo(Math.max(1000 / 1280, 600 / 800), 5);
  });
  it("minScale = max(MIN_SCALE, coverScale)", () => {
    // V: cover = max(0.78125, 0.75) = 0.78125 > MIN_SCALE.
    expect(minScale(V, WORLD)).toBeCloseTo(Math.max(MIN_SCALE, 1000 / 1280), 5);
    // A viewport smaller than the world on both axes: floor is MIN_SCALE.
    const SMALL_V = { width: 400, height: 200 };
    expect(minScale(SMALL_V, WORLD)).toBe(MIN_SCALE);
  });
});

describe("clampZoom", () => {
  it("clamps at absolute min and max without viewport context", () => {
    expect(clampZoom(0.1)).toBe(MIN_SCALE);
    expect(clampZoom(999)).toBe(MAX_SCALE);
  });
  it("clamps at the dynamic cover floor when the viewport is bigger than the world", () => {
    const floor = minScale(BIG_V, WORLD);
    expect(floor).toBeGreaterThan(1);
    expect(clampZoom(0.5, BIG_V, WORLD)).toBeCloseTo(floor, 5);
    expect(clampZoom(999, BIG_V, WORLD)).toBe(MAX_SCALE);
  });
  it("passes through values in range", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(1, V, WORLD)).toBe(1);
    expect(clampZoom(MAX_SCALE, V, WORLD)).toBe(MAX_SCALE);
  });
});

describe("defaultCamera", () => {
  it("centres the world and uses max(1, cover) scale — terrain fills the screen", () => {
    const cam = defaultCamera(BIG_V, WORLD);
    expect(cam.scale).toBeCloseTo(Math.max(DEFAULT_SCALE, coverScale(BIG_V, WORLD)), 5);
    const Wx = WORLD.width * cam.scale;
    const Wy = WORLD.height * cam.scale;
    expect(Wx).toBeGreaterThanOrEqual(BIG_V.width);
    expect(Wy).toBeGreaterThanOrEqual(BIG_V.height);
    expect(cam.x).toBeCloseTo((BIG_V.width - Wx) / 2, 3);
    expect(cam.y).toBeCloseTo((BIG_V.height - Wy) / 2, 3);
  });
  it("uses scale 1 when the world already covers the viewport at 1×", () => {
    const cam = defaultCamera(V, WORLD); // cover 0.78 < 1 → scale 1
    expect(cam.scale).toBe(1);
    // World 1280×800 ≥ viewport 1000×600 → centred exactly (no gaps).
    expect(cam.x).toBeCloseTo((1000 - 1280) / 2, 3);
    expect(cam.y).toBeCloseTo((600 - 800) / 2, 3);
  });
});

describe("zoomStep", () => {
  it("zooms in ×1.1 in range", () => {
    const start = defaultCamera(V, WORLD);
    const result = zoomStep(start, 1, V);
    expect(result.scale).toBeCloseTo(start.scale * ZOOM_STEP, 5);
  });
  it("zooms out ÷1.1 in range", () => {
    const start = defaultCamera(V, WORLD);
    const result = zoomStep(start, -1, V);
    expect(result.scale).toBeCloseTo(start.scale / ZOOM_STEP, 5);
  });
  it("clamps at max scale", () => {
    const start: Camera = { ...defaultCamera(V, WORLD), scale: MAX_SCALE };
    expect(zoomStep(start, 1, V).scale).toBe(MAX_SCALE);
  });
  it("clamps at the dynamic min scale (cannot zoom past cover)", () => {
    const start: Camera = { ...defaultCamera(BIG_V, WORLD), scale: minScale(BIG_V, WORLD) };
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

  it("never lets the world stop covering the viewport (dynamic floor)", () => {
    let cam = defaultCamera(BIG_V, WORLD);
    // Zoom out hard — the floor holds.
    for (let i = 0; i < 40; i++) {
      cam = zoomAtPoint(cam, { x: 1000, y: 800 }, 1 / ZOOM_STEP, BIG_V, WORLD);
    }
    expect(cam.scale).toBeCloseTo(minScale(BIG_V, WORLD), 5);
    expect(WORLD.width * cam.scale).toBeGreaterThanOrEqual(BIG_V.width);
    expect(WORLD.height * cam.scale).toBeGreaterThanOrEqual(BIG_V.height);
  });
});

describe("clampPan", () => {
  it("W > viewport: leaves EDGE_MARGIN of terrain visible on both edges (x)", () => {
    // At scale 2, world x extent = 1280*2 = 2560 > 1000 viewport.
    const extremeLeft: Camera = { x: -5000, y: -5000, scale: 2 };
    const clamped = clampPan(extremeLeft, V);
    // world scaled width W=2560; lower = max(M-W, V-W) = max(60-2560, 1000-2560) = -1560
    // upper = min(V-M,0) = min(940,0) = 0
    expect(clamped.x).toBe(-1560);
    // World visible on the right edge: W + x = 2560 - 1560 = 1000 = V (EDGE_MARGIN to the left).
    expect(WORLD.width * clamped.scale + clamped.x).toBeCloseTo(V.width, 3);
  });

  it("W ≤ viewport: world is centred to cover the viewport", () => {
    // At min scale 0.5, world x extent = 1280*0.5 = 640 < 1000 viewport.
    const pan = clampPan({ ...identity(defaultCamera(V, WORLD)), scale: MIN_SCALE }, V);
    // centred: x should equal (V - W)/2 = (1000 - 640)/2 = 180
    expect(pan.x).toBeCloseTo((V.width - WORLD.width * MIN_SCALE) / 2, 3);
    // Vertical axis: world 800*0.5=400 < 600 → centred y = (600-400)/2 = 100.
    expect(pan.y).toBeCloseTo((V.height - WORLD.height * MIN_SCALE) / 2, 3);
  });

  it("default camera is unchanged when already legal (scale 1 world > viewport)", () => {
    // At scale 1: world 1280x800 > viewport 1000x600; centred default is legal.
    const cam = defaultCamera(V, WORLD);
    const clamped = clampPan(cam, V);
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