/**
 * Pure castle plot layout computation (Phase 3.1) — React-free & deterministic.
 *
 * Houses are laid out in founding order (createdAt ASC) in an outward spiral
 * around the world centre: the first house sits at the heart of the city, and
 * each new house appends to the next free spot on a ring — the city literally
 * grows outward as houses are founded. Each house keeps a stable slot, plus a
 * deterministic size/window variance derived from its id (djb2 hash).
 *
 * The High Lord (kind === 'high_lord', when present) is always pinned to the
 * world centre (slot 0), regardless of founded order; the remaining houses are
 * then laid out on the rings in founding order. Appending an agent house never
 * moves existing agent houses, and the High Lord stays at the heart.
 *
 * Coordinates are absolute pixels within the WORLD canvas; rings stay inside
 * the world bounds for any house count.
 */

/** The world canvas size (px) the castles live on. */
export const WORLD = { width: 1280, height: 800 };

/** A castle plot derived from a house. */
export interface CastlePlot {
  houseId: string;
  /** 0-based founding slot (stable as houses are appended). */
  slot: number;
  /** Horizontal centre, px within WORLD. */
  x: number;
  /** Vertical position, px within WORLD. */
  y: number;
  /** Size multiplier (0.8..1.2) — scales the whole castle. */
  sizeVariance: number;
  /** Number of glowing windows (2 | 3 | 4). */
  windowCount: 2 | 3 | 4;
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

/** Houses on the innermost ring (excluding the centre house). */
const RING_ONE_COUNT = 5;
/** Radius growth between rings (px). */
const RING_RADIUS_STEP = 210;
/** Ellipse flattening — rings are wider than tall to suit the 1280×800 world. */
const RING_FLATTEN = 0.62;
/** Minimum gap between the outermost ring and the world edge (px). */
const RING_INSET = 90;

/**
 * Compute castle plot layout for a set of houses — an outward spiral.
 *
 * - Ordering: the High Lord (if present) always comes first at slot 0 (world
 *   centre); the remaining houses are then sorted by createdAt ASC (founding
 *   order) with a stable id tie-break, so a newly-founded house appends to the
 *   frontier and existing castles keep their slots.
 * - ring 1 holds 5 houses around the centre; ring n ≥ 2 holds n + 4 houses —
 *   the city grows outward as houses are founded. Per-ring golden-angle
 *   staggering keeps rings misaligned.
 * - All coordinates stay inside WORLD for any house count (outer rings clamp
 *   to the bounds via the ellipse geometry).
 */
export function computePlotLayout(
  houses: { id: string; createdAt: string; kind?: string }[],
): CastlePlot[] {
  const highLord = houses.filter((h) => h.kind === "high_lord");
  const others = houses.filter((h) => h.kind !== "high_lord");
  const sorted = [...others].sort((a, b) => {
    // createdAt ASC; stable tie-break on id for determinism.
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const ordered = highLord.length > 0 ? [...highLord, ...sorted] : sorted;

  // Ring geometry per slot: 0 → centre; 1..5 → ring 1; 6..11 → ring 2; …
  const ringOf = (slot: number): { ring: number; indexInRing: number; count: number } => {
    if (slot === 0) return { ring: 0, indexInRing: 0, count: 1 };
    let ring = 1;
    let first = 1; // first slot of the current ring
    for (;;) {
      const count = ring === 1 ? RING_ONE_COUNT : ring + 4;
      if (slot < first + count) return { ring, indexInRing: slot - first, count };
      first += count;
      ring += 1;
    }
  };

  const cx = WORLD.width / 2;
  const cy = WORLD.height / 2;

  return ordered.map((h, i) => {
    const slot = i;
    const { ring, indexInRing, count } = ringOf(slot);

    let x = cx;
    let y = cy;
    if (ring > 0) {
      // Compact the ring so its ellipse fits inside the world: the widest
      // ring can extend cx horizontally and cy vertically at most.
      const maxRadiusX = cx - RING_INSET;
      const maxRadiusY = cy - RING_INSET;
      const desired = ring * RING_RADIUS_STEP;
      // Ellipse axes at the desired radius would be desired (x) and
      // desired * RING_FLATTEN (y); clamp whichever axis would overflow.
      const fitX = maxRadiusX / Math.max(Math.abs(Math.cos(0)), 1); // x-axis extent
      const fitY = maxRadiusY / RING_FLATTEN;
      const radius = Math.min(desired, fitX, fitY);
      // Per-ring golden-angle offset keeps rings visually staggered.
      const offset = (ring * 137.5 * Math.PI) / 180;
      const angle = offset + (indexInRing / count) * Math.PI * 2;
      x = cx + Math.cos(angle) * radius;
      y = cy + Math.sin(angle) * radius * RING_FLATTEN;
    }

    const hash = hashHouseId(h.id);
    const sizeVariance = 0.8 + hashUnit(hash) * 0.4; // 0.8..1.2
    const windowCount = (2 + (Math.floor(hash / 7) % 3)) as 2 | 3 | 4;

    return {
      houseId: h.id,
      slot,
      x: Math.round(x),
      y: Math.round(y),
      sizeVariance,
      windowCount,
    };
  });
}
