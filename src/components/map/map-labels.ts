/**
 * Pure, fixed decorative labels for the top-down archipelago map — React-free.
 *
 * The reference hard-codes five region labels and three sea names against its
 * hand-placed islands. Our archipelago is procedural, so the label anchors are
 * chosen once (offline) to stay:
 *
 * - **inside the visible world** for the default camera on both supported
 *   viewport sizes, so no word is half-cut at the edge (D2), and
 * - **clear of every house island's coastline envelope** plus the house
 *   glyph/label band for the whole separated range (`SEPARATED_HOUSE_LIMIT`).
 *
 * The keep-out maths lives here (not in the component) so it can be unit-tested
 * against the real generated layouts. Labels are pure decoration: moving one
 * never changes the layout, house placement, or any data-attribute contract.
 */

import { coastEnvelope, type Island, type IslandPlot } from "./island-layout";

/** A fixed decorative map label. */
export interface MapLabel {
  /** Stable id (tests / React keys). */
  id: string;
  text: string;
  /** Anchor centre, px within WORLD. */
  x: number;
  y: number;
  /** Font size (px). */
  size: number;
  /** Rotation in degrees about the anchor (default 0). */
  rotate?: number;
  /** Region names are heavier than sea names. */
  kind: "region" | "sea";
}

/**
 * The world area visible under the default camera (D4), inset by 16px so a
 * label at the boundary is never clipped.
 *
 * The default camera now FITS the whole 1600×1000 world (contain scale) at every
 * common viewport, so the entire world is visible on load:
 *  - 1280×720 → panel 960×664 → scale 0.600 → whole world + letterbox
 *  - 1440×900 → panel 1120×844 → scale 0.700 → whole world + letterbox
 *  - 1920×1080 → panel 1600×1024 → scale 1.000 → whole world
 * The band is therefore the world itself, inset by 16px.
 */
export const VISIBLE_LABEL_BAND = {
  x0: 16,
  x1: 1584,
  y0: 16,
  y1: 984,
} as const;

/**
 * How much horizontal room a character needs, as a multiple of font size. A
 * deliberately conservative serif estimate (the CSS also adds letter-spacing).
 */
const CHAR_WIDTH = 0.64;
/** Letter-spacing (em) assumed by `.map-region` / `.map-sea-label`. */
const REGION_TRACKING = 0.35;
const SEA_TRACKING = 0.25;

/** Half-width/half-height of a label's axis-aligned bounding box. */
export function labelHalfExtents(label: MapLabel): { hw: number; hh: number } {
  const tracking = label.kind === "region" ? REGION_TRACKING : SEA_TRACKING;
  const w = label.text.length * label.size * (CHAR_WIDTH + tracking);
  const h = label.size * 1.6;
  const deg = Math.abs(label.rotate ?? 0);
  // Near-vertical labels (the rotated sea names) swap their footprint.
  if (deg >= 60) return { hw: h / 2, hh: w / 2 };
  const rad = (deg * Math.PI) / 180;
  return {
    hw: (w / 2) * Math.cos(rad) + (h / 2) * Math.sin(rad),
    hh: (w / 2) * Math.sin(rad) + (h / 2) * Math.cos(rad),
  };
}

/** The axis-aligned box of a label, in world coordinates. */
export function labelBox(label: MapLabel): { x0: number; y0: number; x1: number; y1: number } {
  const { hw, hh } = labelHalfExtents(label);
  return { x0: label.x - hw, y0: label.y - hh, x1: label.x + hw, y1: label.y + hh };
}

/** Whether a label stays wholly inside the visible band (no edge clipping). */
export function isLabelInsideView(
  label: MapLabel,
  band = VISIBLE_LABEL_BAND,
): boolean {
  const b = labelBox(label);
  return b.x0 >= band.x0 && b.x1 <= band.x1 && b.y0 >= band.y0 && b.y1 <= band.y1;
}

/** Whether a label box overlaps an island's rendered coastline envelope. */
export function labelOverlapsIsland(label: MapLabel, island: Island, margin = 0): boolean {
  const b = labelBox(label);
  const envelope = coastEnvelope(island);
  const rx = island.rx * envelope + margin;
  const ry = island.ry * envelope + margin;
  return Math.abs(island.cx - label.x) < rx + (b.x1 - b.x0) / 2 && Math.abs(island.cy - label.y) < ry + (b.y1 - b.y0) / 2;
}

/**
 * Whether a label box overlaps a house's glyph or its name/role band. House
 * labels sit below the glyph (`y + 30 .. y + 74`), padded by a name's width.
 */
export function labelOverlapsPlot(label: MapLabel, plot: IslandPlot, margin = 0): boolean {
  const b = labelBox(label);
  const hw = (b.x1 - b.x0) / 2;
  const hh = (b.y1 - b.y0) / 2;
  if (Math.abs(plot.x - label.x) < hw + 34 + margin && Math.abs(plot.y - label.y) < hh + 34 + margin) {
    return true;
  }
  return (
    Math.abs(plot.x - label.x) < hw + 80 + margin &&
    label.y + hh > plot.y + 30 &&
    label.y - hh < plot.y + 74
  );
}

/**
 * The fixed decorative labels. Anchors were verified against the real layouts
 * for `0..SEPARATED_HOUSE_LIMIT` houses (see `tests/unit/map-labels.test.ts`):
 * no clipping at either default viewport and no collision with an island or a
 * house label.
 */
export const MAP_LABELS: readonly MapLabel[] = [
  { id: "aurethil", text: "Aurethil", x: 800, y: 380, size: 24, kind: "region" },
  { id: "lanterns", text: "Isle of Lanterns", x: 1060, y: 276, size: 14, kind: "region" },
  { id: "cinder", text: "The Cinder Reach", x: 1000, y: 760, size: 14, kind: "region" },
  { id: "sablewind", text: "Sablewind", x: 400, y: 724, size: 14, kind: "region" },
  { id: "holm", text: "The Pale Holm", x: 844, y: 276, size: 14, kind: "region" },
  { id: "starfall", text: "The Starfall Sea", x: 800, y: 700, size: 15, rotate: 4, kind: "sea" },
  { id: "mistveil", text: "Mistveil Strait", x: 1128, y: 500, size: 13, rotate: -68, kind: "sea" },
  { id: "quiet", text: "Sea of Quiet Lanterns", x: 440, y: 500, size: 13, rotate: -90, kind: "sea" },
];

/**
 * Truncate an arbitrarily long house name to a bounded visual label so adjacent
 * house labels cannot sprawl across a neighbour's island. The `aria-label` keeps
 * the full name; only the painted glyph is shortened.
 *
 * Truncation happens **at a word boundary** (D5): the cut never lands inside a
 * word, so the label reads cleanly instead of "Spell-clever · softw…". If the
 * text has no space within the budget the single long word is cut as a last
 * resort. The ellipsis counts toward `max`.
 *
 * The max lengths are chosen so that two worst-case labels on adjacent
 * satellites (≥148px apart at the closest point in the separated range) do not
 * collide: `16 × 15px × 0.62 ≈ 74px` half-width, i.e. 148px combined.
 */
export function clipLabel(text: string, max = 18): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const budget = max - 1; // reserve one character for the ellipsis
  const window = trimmed.slice(0, budget);
  const lastSpace = window.lastIndexOf(" ");
  if (lastSpace > 0) return `${trimmed.slice(0, lastSpace).trimEnd()}…`;
  return `${window.trimEnd()}…`;
}

/**
 * The painted role label for a house. Roles are authored as
 * `"Function · description"` (e.g. `"Spell-cleaver · software developer"`); the
 * function is the useful, glanceable part, so we paint it and drop the
 * description rather than cutting the whole string mid-word. Long functions are
 * still word-boundary-clipped (D5).
 */
export function houseRoleLabel(role: string, max = 22): string {
  const trimmed = role.trim();
  const sep = trimmed.indexOf("·");
  const fn = sep >= 0 ? trimmed.slice(0, sep).trim() : trimmed;
  return clipLabel(fn || trimmed, max);
}

/** Max painted characters for a house name (see `clipLabel`). */
export const HOUSE_NAME_MAX = 16;
/** Max painted characters for a house role (function only). */
export const HOUSE_ROLE_MAX = 22;
/**
 * Font sizes used by `.map-house-label` / `.map-house-role` in globals.css.
 * These must match the CSS (the role is 11px, not 10px) — the collision maths in
 * `tests/unit/map-labels.test.ts` depends on them.
 */
export const HOUSE_NAME_FONT_SIZE = 15;
export const HOUSE_ROLE_FONT_SIZE = 11;
