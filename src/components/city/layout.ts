/**
 * Pure city layout computation (Phase 3) — React-free & deterministic.
 *
 * Houses are laid out in founding order (createdAt ASC) into a responsive
 * grid of `columns` (default 5) that wraps into rows. Each building gets a
 * stable slot plus deterministic height/roof/tint variants derived from its
 * house id (djb2 hash).
 *
 * Coordinates are expressed as percentages (0..100) of the skyline viewBox.
 */

/** A building plot derived from a house. */
export interface CityPlot {
  houseId: string;
  /** 0-based founding slot (stable as houses are appended). */
  slot: number;
  /** Horizontal centre, 0..100 (% of viewBox width). */
  x: number;
  /** Building baseline (bottom), 0..100 (% of viewBox height). */
  y: number;
  /** Height multiplier (0.6..1.4) — scales the building facade. */
  heightVariance: number;
  /** Roof silhouette pick: 0 | 1 | 2. */
  roofVariant: 0 | 1 | 2;
  /** Window tint pick: 0 | 1 | 2. */
  tintVariant: 0 | 1 | 2;
}

/**
 * djb2 string hash (unsigned). Deterministic across runs; used to derive a
 * house's visual variants.
 */
export function hashHouseId(id: string): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) >>> 0; // h * 33 + c
  }
  return hash >>> 0;
}

/** Normalize to 0..1 given a raw hash. */
function hashUnit(h: number): number {
  return (h % 1000) / 1000;
}

/**
 * Compute city layout for a set of houses.
 *
 * - Sorted by createdAt ASC (founding order) so a newly-founded house appends
 *   to the end and existing buildings keep their slots.
 * - slot = index in the sorted list.
 * - Wraps into rows of `columns`; later rows sit higher (skyline recedes).
 */
export function computeCityLayout(
  houses: { id: string; createdAt: string }[],
  opts?: { columns?: number },
): CityPlot[] {
  const columns = opts?.columns && opts.columns > 0 ? opts.columns : 5;
  const bandW = 100 / columns;

  const sorted = [...houses].sort((a, b) => {
    // createdAt ASC; stable tie-break on id for determinism.
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const rowStep = 9; // percent rise per row above the ground line.

  return sorted.map((h, i) => {
    const row = Math.floor(i / columns);
    const col = i % columns;
    const x = bandW * col + bandW / 2;

    // Baselines: founding houses sit lowest (foreground); wrapped rows go up.
    const y = 92 - Math.max(0, row) * rowStep;

    const hash = hashHouseId(h.id);
    const heightVariance = 0.6 + hashUnit(hash) * 0.8; // 0.6..1.4
    const roofVariant = (hash % 3) as 0 | 1 | 2;
    const tintVariant = (Math.floor(hash / 3) % 3) as 0 | 1 | 2;

    return {
      houseId: h.id,
      slot: i,
      x,
      y,
      heightVariance,
      roofVariant,
      tintVariant,
    };
  });
}
