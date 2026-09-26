/**
 * Pure seeded randomness helpers for the top-down archipelago map — React-free
 * and deterministic, so procedurally generated geometry is identical between
 * the server and the client (no `Math.random`, no wall-clock reads).
 *
 * `mulberry32` is ported verbatim from the design reference
 * (`/home/kate/Downloads/velaris-map.html`, `rng(seed)`), which seeds the whole
 * archipelago, star field, and terrain.
 */

/**
 * djb2 string hash (unsigned 32-bit). Deterministic across runs; used to
 * derive stable per-house visual variants and per-island seeds.
 */
export function hashHouseId(id: string): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) >>> 0; // h * 33 + c
  }
  return hash >>> 0;
}

/** A deterministic pseudo-random number generator returning values in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32 — ported verbatim from the reference `rng(seed)`
 * (velaris-map.html). Fast, deterministic 32-bit PRNG.
 */
export function mulberry32(seed: number): Rng {
  let state = seed | 0;
  return function rng(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convenience: seed a PRNG from mixed string/number parts via `hashHouseId`.
 * Deterministic for identical parts in identical order.
 */
export function seededRng(...parts: Array<string | number>): Rng {
  return mulberry32(hashHouseId(parts.map((p) => String(p)).join("\u0000")));
}

/**
 * A deterministic CSS `animation-delay` string in seconds, always negative so
 * staggered elements start mid-cycle. Mirrors the reference `anim()` helper
 * (`-Math.random() * dur`) but derives the offset from a stable seed instead of
 * `Math.random`, keeping SSR and hydration output identical.
 */
export function fxDelay(seed: number, durationSeconds: number): string {
  // 0.001..1.0 — never exactly zero so the delay is always negative.
  const frac = (((seed >>> 0) % 1000) + 1) / 1000;
  return `${(-frac * durationSeconds).toFixed(2)}s`;
}
