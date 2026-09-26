/**
 * Unit tests for the pure seeded-random helpers
 * (src/components/map/random.ts).
 */

import { describe, it, expect } from "vitest";
import { hashHouseId, mulberry32, seededRng, fxDelay } from "@/components/map/random";

describe("hashHouseId", () => {
  it("is stable across calls", () => {
    expect(hashHouseId("abc")).toBe(hashHouseId("abc"));
  });
  it("differs for different ids", () => {
    expect(hashHouseId("abc")).not.toBe(hashHouseId("abd"));
  });
  it("is a non-negative 32-bit integer", () => {
    for (const id of ["a", "house-1", "very-long-house-id-for-testing"]) {
      const h = hashHouseId(id);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });
});

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(2026);
    const b = mulberry32(2026);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(Array.from({ length: 5 }, () => a())).not.toEqual(Array.from({ length: 5 }, () => b()));
  });

  it("stays within [0, 1)", () => {
    const r = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("seededRng", () => {
  it("is deterministic for identical parts", () => {
    const a = seededRng("house", 7);
    const b = seededRng("house", 7);
    expect(Array.from({ length: 10 }, () => a())).toEqual(Array.from({ length: 10 }, () => b()));
  });

  it("distinguishes part order and values", () => {
    expect(seededRng("a", "b")()).not.toBe(seededRng("ab")());
    expect(seededRng("a", 1)()).not.toBe(seededRng("a", 2)());
  });
});

describe("fxDelay", () => {
  it("returns a negative-seconds string", () => {
    for (const seed of [0, 1, 12345, 2 ** 31]) {
      const d = fxDelay(seed, 5);
      expect(d).toMatch(/^-\d+\.\d{2}s$/);
      expect(parseFloat(d)).toBeLessThan(0);
    }
  });

  it("is deterministic and bounded by the duration", () => {
    expect(fxDelay(99, 4)).toBe(fxDelay(99, 4));
    expect(Math.abs(parseFloat(fxDelay(99, 4)))).toBeLessThanOrEqual(4);
  });
});
