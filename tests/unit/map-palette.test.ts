/**
 * Unit tests for the pure castle palette derivation (src/components/map/palette.ts).
 */

import { describe, it, expect } from "vitest";
import {
  paletteForHouse,
  PALETTE_NAMES,
  type CastlePalette,
  type GradientTriple,
  type PaletteName,
} from "@/components/map/palette";

/** Relative luminance of a #rrggbb color (0..1) — used to compare "brightness". */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const PARTS: (keyof CastlePalette)[] = ["keep", "roof", "tower"];

describe("paletteForHouse", () => {
  it("is stable for a given id", () => {
    expect(paletteForHouse("abc")).toEqual(paletteForHouse("abc"));
  });

  it("reaches all 5 palette names across variable ids", () => {
    const names = new Set<PaletteName>();
    for (let i = 0; i < 100; i++) {
      names.add(paletteForHouse(`house-${i}`).name);
    }
    for (const n of PALETTE_NAMES) {
      expect(names.has(n)).toBe(true);
    }
  });

  it("never produces a name outside the rotation", () => {
    for (let i = 0; i < 50; i++) {
      expect(PALETTE_NAMES).toContain(paletteForHouse(`id-${i}`).name);
    }
  });

  it("produces valid 6-digit hex gradient triples for every part", () => {
    for (let i = 0; i < 50; i++) {
      const p = paletteForHouse(`house-${i}`);
      for (const part of PARTS) {
        const triple = p[part as keyof Pick<CastlePalette, "keep" | "roof" | "tower">] as GradientTriple;
        for (const tone of ["light", "base", "dark"] as const) {
          expect(triple[tone]).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    }
  });

  it("has light strictly brighter than dark for each triple", () => {
    for (let i = 0; i < 50; i++) {
      const p = paletteForHouse(`house-${i}`);
      for (const part of PARTS) {
        const triple = p[part as keyof Pick<CastlePalette, "keep" | "roof" | "tower">] as GradientTriple;
        expect(luminance(triple.light)).toBeGreaterThan(luminance(triple.base));
        expect(luminance(triple.base)).toBeGreaterThan(luminance(triple.dark));
      }
    }
  });

  it("is structurally complete for every palette", () => {
    for (let i = 0; i < 50; i++) {
      const p = paletteForHouse(`house-${i}`);
      expect(p.windowGlow).toBe("#ffd97a");
      expect(p.windowGlowSoft).toBe("#ffd97a");
      for (const part of PARTS) {
        const triple = p[part as keyof Pick<CastlePalette, "keep" | "roof" | "tower">] as GradientTriple;
        expect(triple).toHaveProperty("light");
        expect(triple).toHaveProperty("base");
        expect(triple).toHaveProperty("dark");
      }
    }
  });
});
