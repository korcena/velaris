/**
 * Pure camera math for the castle map (Phase 3.1) — React-free & deterministic.
 *
 * A camera is `{ x, y, scale }` where (x, y) is the pan offset applied to the
 * world wrapper and scale is the zoom factor. All zoom/pan/clamp logic lives
 * here so it can be unit-tested in a node environment.
 */

import { WORLD } from "./island-layout";

/** Camera state: pan offset (px) + zoom scale. */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 2.5;
export const ZOOM_STEP = 1.1;
export const EDGE_MARGIN = 60;

/**
 * The smallest scale at which the world still *covers* the viewport (no empty
 * edges): `max(viewport/world)` per axis. Kept for the crop-to-fill geometry
 * tests; it is no longer the default camera's rule (see `containScale`).
 */
export function coverScale(
  viewport: Viewport,
  world: { width: number; height: number },
): number {
  return Math.max(viewport.width / world.width, viewport.height / world.height);
}

/**
 * The largest scale at which the whole world still *fits inside* the viewport:
 * `min(viewport/world)` per axis. This is the default camera's scale (D4) so
 * every house island is on screen from the first render at common viewports.
 */
export function containScale(
  viewport: Viewport,
  world: { width: number; height: number },
): number {
  return Math.min(viewport.width / world.width, viewport.height / world.height);
}

/**
 * Effective (dynamic) minimum zoom: the scale at which the whole world exactly
 * fits the viewport (`containScale`). This is the true zoom-out floor (D4): a
 * user can always bring *every* island on screen and can never zoom out past
 * the point where the world stops fitting, so the floor can never sit above the
 * default camera's scale and clamp it back into a crop.
 *
 * `MIN_SCALE` remains the fallback used by `clampZoom` when no viewport is
 * supplied. On a viewport so small that fitting needs a scale below `MIN_SCALE`,
 * fitting wins — the whole world must stay reachable.
 */
export function minScale(viewport: Viewport, world: { width: number; height: number }): number {
  return Math.min(MAX_SCALE, containScale(viewport, world));
}

/** Clamp a zoom scale into [minScale(viewport, world), MAX_SCALE]. */
export function clampZoom(scale: number, viewport?: Viewport, world?: { width: number; height: number }): number {
  const min = viewport && world ? minScale(viewport, world) : MIN_SCALE;
  return Math.max(min, Math.min(MAX_SCALE, scale));
}

/** A viewport size in px. */
export interface Viewport {
  width: number;
  height: number;
}

/** A point in viewport pixels (a pointer/cursor position). */
export interface Point {
  x: number;
  y: number;
}

/** A single point in the (scaled) world. */
type Pan = Point;

/**
 * Default camera: the whole world fitted (contained) inside the viewport and
 * centred — every house island is on screen from the first render at common
 * viewports (D4). The abyss-coloured ground layer fills any letterbox margin.
 *
 * The scale is `containScale`, then clamped — but `minScale` is defined to be
 * ≤ `containScale`, so the clamp is a no-op for the default (asserted by the
 * camera tests): `defaultCamera` never returns a scale that `clampZoom`
 * rejects.
 */
export function defaultCamera(
  viewport: Viewport,
  world: { width: number; height: number } = WORLD,
): Camera {
  const scale = clampZoom(containScale(viewport, world), viewport, world);
  const Wx = world.width * scale;
  const Wy = world.height * scale;
  return {
    x: (viewport.width - Wx) / 2,
    y: (viewport.height - Wy) / 2,
    scale,
  };
}

/**
 * The axis-aligned rectangle of *world* coordinates currently visible in the
 * viewport for a camera. A world point `(wx, wy)` maps to viewport pixels
 * `(camera.x + wx·scale, camera.y + wy·scale)`, so the inverse of the viewport
 * box `[0, Vw] × [0, Vh]` is this rect. Used by tests to assert that every house
 * plot is on screen under the default camera (D4).
 */
export function visibleWorldRect(
  camera: Camera,
  viewport: Viewport,
): { x0: number; y0: number; x1: number; y1: number } {
  const left = -camera.x / camera.scale;
  const top = -camera.y / camera.scale;
  return {
    x0: left,
    y0: top,
    x1: left + viewport.width / camera.scale,
    y1: top + viewport.height / camera.scale,
  };
}

/**
 * Clamp one pan axis given the scaled world extent `W` and viewport extent `V`.
 *
 * Two regimes:
 *  - W > V (zoom in, world larger than viewport): clamp so an EDGE_MARGIN of
 *    terrain stays visible on both edges.
 *  - W ≤ V (world smaller than viewport — only possible before the viewport
 *    is measured): centre the world so no axis drifts away.
 */
function clampAxis(pan: number, W: number, V: number, M: number): number {
  if (W <= V) {
    // World fits within the viewport — centre it to avoid empty edges.
    return (V - W) / 2;
  }
  const lower = Math.max(M - W, V - W);
  const upper = Math.min(V - M, 0);
  return Math.max(lower, Math.min(upper, pan));
}

/** Clamp the pan so the world stays visible for the given scale. */
export function clampPan(camera: Camera, viewport: Viewport, world = WORLD): Camera {
  const Wx = world.width * camera.scale;
  const Wy = world.height * camera.scale;
  const x = clampAxis(camera.x, Wx, viewport.width, EDGE_MARGIN);
  const y = clampAxis(camera.y, Wy, viewport.height, EDGE_MARGIN);
  return x === camera.x && y === camera.y ? camera : { x, y, scale: camera.scale };
}

/**
 * Zoom the camera *toward the viewport centre* by one step.
 * `direction` is 1 to zoom in, -1 to zoom out.
 */
export function zoomStep(
  camera: Camera,
  direction: 1 | -1,
  viewport: Viewport,
  world = WORLD,
): Camera {
  const factor = direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  const cursor: Point = { x: viewport.width / 2, y: viewport.height / 2 };
  return zoomAtPoint(camera, cursor, factor, viewport, world);
}

/**
 * Zoom the camera so the world point under `cursor` stays under the cursor.
 * The cursor is in viewport pixels; the scale changes by `factor`.
 */
export function zoomAtPoint(
  camera: Camera,
  cursor: Point,
  factor: number,
  viewport: Viewport,
  world = WORLD,
): Camera {
  const scale = clampZoom(camera.scale * factor, viewport, world);
  // World point currently under the cursor (before scaling).
  const worldPt: Point = {
    x: (cursor.x - camera.x) / camera.scale,
    y: (cursor.y - camera.y) / camera.scale,
  };
  // New pan keeps that world point under the cursor.
  const panned: Camera = {
    x: cursor.x - worldPt.x * scale,
    y: cursor.y - worldPt.y * scale,
    scale,
  };
  return clampPan(panned, viewport, world);
}

/**
 * Whether a pointer movement of `end - start` should be treated as a drag
 * (suppressing a click). True when the Euclidean distance strictly exceeds
 * the threshold (default 5px).
 */
export function isDrag(start: Point, end: Point, threshold = 5): boolean {
  const d = Math.hypot(end.x - start.x, end.y - start.y);
  return d > threshold;
}
