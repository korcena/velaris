"use client";

/**
 * IslandGlyph — the top-down citadel a house lives in, ported from the design
 * reference's `buildGlyph` (velaris-map.html:647-671).
 *
 * A soft ground shadow, an octagon wall, four turrets, an octagon roof with
 * eight ridges, and a state-coloured finial (`--fx-color`). The parent
 * positions the glyph with `<g transform="translate(x y) scale(s)">`, so this
 * component never carries a positional transform and its animated children can
 * use CSS transforms safely.
 *
 * `highLord` adds a gold gild so the throne reads distinctly at the world
 * heart. Per plan Q5 a subtle per-house tint is applied via `paletteName`.
 */

import type { CSSProperties } from "react";
import { EFFECT_COLORS, type PaletteName } from "./palette";
import type { MapEffect } from "./status-effects";

/** A closed regular octagon path of radius `r`, rotated by `rot` radians. */
export function octagonPath(r: number, rot = Math.PI / 8): string {
  let d = "";
  for (let i = 0; i < 8; i++) {
    const a = rot + (i * Math.PI) / 4;
    d += `${i ? "L" : "M"}${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
  }
  return `${d}Z`;
}

/** The four turret anchors around the wall (reference: π/4 + i·π/2). */
const TURRETS = [0, 1, 2, 3].map((i) => {
  const a = Math.PI / 4 + (i * Math.PI) / 2;
  return { cx: Number((Math.cos(a) * 15).toFixed(2)), cy: Number((Math.sin(a) * 15).toFixed(2)) };
});

/** The eight roof ridges (reference: π/8 + i·π/4). */
const RIDGES = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
  const a = Math.PI / 8 + (i * Math.PI) / 4;
  return {
    x2: Number((Math.cos(a) * 9).toFixed(2)),
    y2: Number((Math.sin(a) * 9).toFixed(2)),
  };
});

/** Per-palette gilds so adjacent islands do not read identically. */
const PALETTE_TINT: Record<PaletteName, string> = {
  purple: "#3b3a6e",
  gold: "#5a5230",
  teal: "#2f4f57",
  crimson: "#5a3a45",
  silver: "#464a6e",
};

export function IslandGlyph({
  effect,
  sizeVariance,
  highLord,
  paletteName,
  seed = 0,
}: {
  effect: MapEffect;
  sizeVariance: number;
  highLord: boolean;
  /** Optional per-house hue so islands are subtly distinct (plan Q5). */
  paletteName?: PaletteName;
  /** Stable seed for the finial's glow timing (no Math.random in render). */
  seed?: number;
}) {
  const finialColor = highLord ? "#ffcf6e" : EFFECT_COLORS[effect];
  // Idle/need breathe slowly, working is brisk, planning is calm; fail glows
  // static (the flickering aura carries that state instead).
  const glowSeconds = effect === "working" ? 1 : effect === "need" ? 0.7 : effect === "planning" ? 3 : 4;
  const tint = paletteName ? PALETTE_TINT[paletteName] : undefined;

  return (
    <g className={`map-glyph s-${effect}`} transform={`scale(${sizeVariance.toFixed(3)})`}>
      {/* Soft ground shadow (static translucent disc — no blur filter, plan Q4). */}
      <circle cx={2.5} cy={3.5} r={16} fill="#05071a" opacity={0.45} />
      {/* Octagon wall. */}
      <path d={octagonPath(15)} className="wall" style={tint ? { fill: tint } : undefined} />
      {/* Four turrets. */}
      {TURRETS.map((t, i) => (
        <circle key={i} cx={t.cx} cy={t.cy} r={3.6} className="turret" />
      ))}
      {/* Octagon roof + eight ridges. */}
      <path d={octagonPath(9)} className="roof" />
      {RIDGES.map((r, i) => (
        <line key={i} x1={0} y1={0} x2={r.x2} y2={r.y2} className="ridge" />
      ))}
      {/* State-coloured finial: a static disc plus an animated halo so its glow
          stays transform/opacity only (no SVG filter). */}
      <circle
        className="fx-glow"
        r={6}
        fill={finialColor}
        opacity={0.28}
        style={{ "--dur": `${glowSeconds}s`, animationDelay: `-${(seed % 100) / 100}s` } as CSSProperties}
      />
      <circle r={2.8} className="finial" style={{ fill: finialColor }} />
    </g>
  );
}
