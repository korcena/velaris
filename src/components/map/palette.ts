/**
 * Pure castle palette derivation (Phase 3.1) — React-free & deterministic.
 *
 * Each house gets a stable palette picked by hashing its id. Every palette
 * provides three-tone gradients (light → base → dark) for each architectural
 * part, computed by pure RGB interpolation toward white/black from a Velaris
 * base token. Roof is mixed slightly darker, tower slightly lighter than keep.
 */

import { hashHouseId } from "./random";
import type { MapEffect } from "./status-effects";

/** A single 6-digit hex color, e.g. "#7c6cf0". */
export type HexColor = `#${string}`;

/** Three-tone gradient for a single architectural part. */
export interface GradientTriple {
  light: HexColor;
  base: HexColor;
  dark: HexColor;
}

/** The full palette for one house. */
export interface CastlePalette {
  name: PaletteName;
  keep: GradientTriple;
  roof: GradientTriple;
  tower: GradientTriple;
  /** Warm amber window glow. */
  windowGlow: "#ffd97a";
  /** Softer window glow for idle windows. */
  windowGlowSoft: "#ffd97a";
}

/** The 5 palette names in rotation. */
export type PaletteName = "purple" | "gold" | "teal" | "crimson" | "silver";

/** Rotational palette order (stable, derived by hash modulo 5). */
export const PALETTE_NAMES: readonly PaletteName[] = [
  "purple",
  "gold",
  "teal",
  "crimson",
  "silver",
];

/** Velaris base tokens for each palette (keep = the primary wall tone). */
const BASE_TOKEN: Record<PaletteName, string> = {
  purple: "#7c6cf0",
  gold: "#e8c66b",
  teal: "#5ecfb8",
  crimson: "#e36a6a",
  silver: "#cdd3f0",
};

/** Parse "#rrggbb" → [r, g, b] bytes. */
function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Serialize [r, g, b] bytes → "#rrggbb". */
function toHex(r: number, g: number, b: number): HexColor {
  const c = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Interpolate a color toward white by `amount` (0..1). */
function towardWhite(hex: string, amount: number): HexColor {
  const [r, g, b] = parseHex(hex);
  return toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

/** Interpolate a color toward black by `amount` (0..1). */
function towardBlack(hex: string, amount: number): HexColor {
  const [r, g, b] = parseHex(hex);
  return toHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

/** Mix two colors: `a` weighted by `t`, `b` by (1-t). */
function mix(a: string, b: string, t: number): HexColor {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex(ar * t + br * (1 - t), ag * t + bg * (1 - t), ab * t + bb * (1 - t));
}

/**
 * Derive a three-tone gradient for an architectural part from a base hex:
 * light ≈ +15% toward white, dark ≈ −20% toward black, base = the token.
 */
function tripleFrom(base: string): GradientTriple {
  return {
    light: towardWhite(base, 0.15),
    base: base as HexColor,
    dark: towardBlack(base, 0.2),
  };
}

/**
 * The palette for a house, keyed by its id. Deterministic: same id → same
 * palette. Rotation covers all 5 names as ids vary.
 */
export function paletteForHouse(houseId: string): CastlePalette {
  const name = PALETTE_NAMES[hashHouseId(houseId) % PALETTE_NAMES.length];
  const keepBase = BASE_TOKEN[name];

  // Roof slightly darker than keep; tower slightly lighter than keep.
  const keep = tripleFrom(keepBase);
  const roof = tripleFrom(towardBlack(keepBase, 0.12));
  const tower = tripleFrom(towardWhite(keepBase, 0.12));

  return {
    name,
    keep,
    roof,
    tower,
    windowGlow: "#ffd97a",
    windowGlowSoft: "#ffd97a",
  };
}

/**
 * The reference map palette (velaris-map.html), scoped as the map's local CSS
 * custom properties in globals.css. Kept here as data so JS-driven colour (the
 * legend, drawer pill, per-state finial) matches the CSS variables exactly.
 */
export const MAP_PALETTE = {
  abyss: "#0c1030",
  sea: "#1a2352",
  land: "#262c52",
  landHi: "#333b69",
  roof: "#3d4679",
  ink: "#aab6ea",
  inkDim: "#5b6599",
  label: "#ece8ff",
  text: "#d9dcf2",
  textDim: "#9097bf",
  idle: "#8fb8ff",
  work: "#ffcf6e",
  need: "#ff7ad9",
  fail: "#e0523f",
  ash: "#6f6a80",
  paused: "#6f7bb0",
} as const;

/**
 * Effect → colour, matching the scoped CSS variables. Used for the finial
 * (island glyph), the drawer status pill, and the legend count. `paused` and
 * `dimmed` are calm/ash so an inactive house reads as set aside.
 */
export const EFFECT_COLORS: Record<MapEffect, string> = {
  idle: MAP_PALETTE.idle,
  planning: MAP_PALETTE.paused,
  working: MAP_PALETTE.work,
  need: MAP_PALETTE.need,
  paused: MAP_PALETTE.paused,
  fail: MAP_PALETTE.fail,
  dimmed: MAP_PALETTE.ash,
};
