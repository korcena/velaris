# Top-Down Archipelago Map — Implementation Plan

**Date:** 2026-09-26
**Baseline:** HEAD `4beeb64` ("Add design spec for top-down archipelago map"), working tree clean.
**Source of truth:** `docs/superpowers/specs/2026-09-26-archipelago-map-design.md` (approved/frozen).
**Visual/behavioural reference:** `/home/kate/Downloads/velaris-map.html` (1000 lines, vanilla SVG+CSS).
**Author:** planning agent — no production code written.

> The design is frozen. This plan does **not** re-litigate decisions; it turns them into ordered,
> file-level work grounded in the code at HEAD. The single intentional behaviour change is
> §6.1 click semantics (click → drawer, "Open house →" navigates), and its e2e update is bundled
> with the change so the tree is **always green**.

---

## 0. Codebase verification findings (read before implementing)

| Question | Verified answer |
|---|---|
| Current map entry | `src/app/map/page.tsx` renders the `Map` `<h1>` chip + subtitle "The city at a glance" and `<CastleMap/>`. **Keep the `Map` heading** (§8). |
| Orchestrator | `src/components/map/castle-map.tsx` (391 lines): fetches `/api/houses?includeArchived=true&includeHighLord=true`, subscribes via `useVelarisStream()` (`sequence` refetch + `on()` frames), celebration guard/timers (`createCelebrationGuard`, `celebrationFromFrame`), camera (`camera.ts`), viewport measurement, native non-passive wheel, drag-suppress-click. |
| Castle rendering | `src/components/map/castle.tsx` (274 lines) — CSS-DOM (not SVG), `data-state`/`data-kind`/`data-plan-state`/`data-testid`, celebration + burning overlays, messenger bird + `map-bird-dot-<id>`. |
| Layout | `src/components/map/plot-layout.ts` exports `WORLD {1280,800}`, `hashHouseId`, `computePlotLayout` (outward spiral, HL pinned slot 0). **Deleted**; `hashHouseId` moves to `random.ts`, `WORLD` moves to `island-layout.ts`. |
| Camera | `src/components/map/camera.ts` imports `WORLD` from `./plot-layout`; `tests/unit/map-camera.test.ts` also imports it and has **hardcoded clamp numbers** derived from 1280×800. |
| Palette | `src/components/map/palette.ts` imports `hashHouseId` from `./plot-layout`; `paletteForHouse` is id-hash → 5-name rotation. `tests/unit/map-palette.test.ts` asserts the full API. |
| Realtime | `src/components/realtime/velaris-stream.tsx` — `sequence` tick + `on(handler)`. `src/components/map/animation-map.ts` — `statusToVisualState`, `celebrationFromFrame`, `createCelebrationGuard`. **Kept** (spec §9). |
| Reduced motion | `src/components/map/reduced-motion.ts` — `useVelarisReducedMotion()` + pure `isReducedMotionActive`. Global CSS clamps at `globals.css:105-123` (`.velaris-reduced-motion`). **Kept.** |
| House data | `HouseCardData` (`house-card.tsx:19`) = `HouseDto` + `runtimeStatus` + `pendingApprovals` + optional `planState`. `HouseDetailDto.activeTask {id,title,status}` exists **only on `/api/houses/{id}`** — the list omits the active task. |
| Statuses | `HouseRuntimeStatus` (`types.ts:343`): idle/planning/working/awaiting_approval/awaiting_input/paused. `HouseStatus` active/disabled/archived. `HighLordPlanState` idle/planning/active/aborted/completed (`types.ts:450`). `deriveRuntimeStatus` (`execution-service.ts:23`) maps session pending→planning, running→working. |
| `/roost` | No per-house query parameter (verified `src/app/roost/page.tsx`) → the drawer's "Messenger Roost →" links to `/roost`. |
| E2E map consumers | `tests/e2e/phase3-map.spec.ts` (primary), `tests/e2e/phase4-court.spec.ts:243-266` asserts `data-kind="high_lord"`, `data-plan-state="aborted"`, **and `map-castle-burning` `.or()` `map-castle-burning-static`**, `tests/e2e/default-houses.spec.ts:37-43` asserts `map-castle-<id>` + `aria-label`. |
| Empty-state copy | Current `map-empty` ("The city's great houses lie empty") is **not asserted by any test** (grep) — safe to reword. |
| Tests infra | Vitest node env (pure modules only); Playwright 1280×720, `workers:1`, web-only, seeds DB directly, no engine. |
| Docs | README lines 19 and 74-79 describe "shaded castles"/"outward in rings". `AGENTS.md`/`docs/ARCHITECTURE.md` contain **no** city-map references (grep) → README only. |

---

## 1. Objective

Replace the isometric shaded-castle city view at `/map` with a **top-down fantasy archipelago**:
each house is a citadel on its own seeded island, its runtime state shown through pure SVG/CSS
"magic" effects (breathing auras, rune rings, lighthouse sweeps, embers). The map keeps live house
data, realtime celebrations, pan/zoom, reduced-motion, accessibility and all §8 contracts, and gains
a cartouche, a filtering legend, and a deep-linking drawer. No new dependency, no Google Fonts, no
engine/schema/realtime change, no inline approval actions.

---

## 2. Relevant files

**Created** (`src/components/map/`): `random.ts`, `island-layout.ts`, `terrain.ts`,
`status-effects.ts`, `island-glyph.tsx`, `effect.tsx`, `map-legend.tsx`, `map-drawer.tsx`.

**Modified**: `src/components/map/castle-map.tsx` (rewrite), `camera.ts` (WORLD import),
`palette.ts` (add `MAP_PALETTE`, hash import), `src/app/map/page.tsx` (subtitle only),
`src/app/globals.css` (map CSS block), `tests/unit/map-camera.test.ts`,
`tests/e2e/phase3-map.spec.ts`, `README.md`.

**Deleted**: `src/components/map/castle.tsx`, `src/components/map/plot-layout.ts`,
`tests/unit/map-plot-layout.test.ts`.

**Untouched (must stay green)**: `animation-map.ts`, `reduced-motion.ts`,
`tests/unit/map-{palette,animation-map}.test.ts`, `tests/e2e/{default-houses,phase4-court}.spec.ts`.

---

## 3. Stages

Each stage ends with the tree green: `npx tsc --noEmit` → `npm test` (and `npm run test:e2e` where
noted). Stage D bundles the §6.1 e2e update with the behaviour change so no intermediate commit is
red.

---

### Stage A — Pure geometry & terrain (no React) — **M**

**Deliverable:** deterministic, append-stable archipelago layout + seeded terrain generator, both
React-free and unit-tested.

**Create `src/components/map/random.ts`**
```ts
/** djb2 unsigned hash — moved verbatim from plot-layout.ts:41. */
export function hashHouseId(id: string): number;
/** mulberry32 — ported from the reference `rng(seed)` (velaris-map.html:463-470). */
export function mulberry32(seed: number): () => number;
/** Convenience: seed from mixed string/number parts via hashHouseId. */
export function seededRng(...parts: Array<string | number>): () => number;
/** Negative animation-delay for staggered starts (SSR-safe; no Math.random). */
export function fxDelay(seed: number, durationSeconds: number): string;
```

**Create `src/components/map/island-layout.ts`**
```ts
export const WORLD = { width: 1600, height: 1000 } as const;
export const WORLD_SEED = 2026;              // reference seed
export const RING_ONE_COUNT = 5;
export const RING_RADIUS_STEP = 190;
export const RING_FLATTEN = 0.62;
export const RING_INSET = 130;
export const HEART = { rx: 420, ry: 285, rough: 0.2, seed: 11 };  // reference heart island

export interface FourierHarmonic { k: number; a: number; p: number }
export interface Island {
  id: string;                 // "heart" | `island-${slot}` | `islet-${i}`
  slot: number;               // -1 for decorative islets
  houseId: string | null;     // null ⇒ decorative
  cx: number; cy: number; rx: number; ry: number;
  seed: number; rough: number; harmonics: FourierHarmonic[];
}
export interface IslandPlot { houseId: string; slot: number; islandId: string; x: number; y: number; sizeVariance: number }
export interface IslandLayout { world: { width: number; height: number }; islands: Island[]; islets: Island[]; plots: IslandPlot[] }

export function makeHarmonics(seed: number, rough: number): FourierHarmonic[];
export function computeIslandLayout(houses: { id: string; createdAt: string; kind?: string }[]): IslandLayout;
export function islandRadius(island: Island, t: number): number;
export function islandPath(island: Island, m?: number, segments?: number): string;   // m default 1, segments 160
export function isPointOnLand(islands: Island[], x: number, y: number, f?: number): boolean;
```
Rules (mirrors `plot-layout.ts` semantics so `map-camera.test.ts` port is mechanical):
- Ordering: High Lord first (slot 0); others by `createdAt ASC`, `id` tiebreak. No HL ⇒ first founded
  house takes the heart (preserves "first house at the centre"). Empty ⇒ `islands:[], plots:[]` plus islets.
- Slot 0 → heart island centred at `WORLD/2`, `HEART` ellipse.
- Ring scheme identical to plot-layout for append stability: ring 1 = 5, ring n≥2 = n+3, per-ring
  golden-angle offset `ring*137.5°`. Existing slots never depend on total N.
- Satellite island `rx = clamp(170 - (n-1)*14, 60, 170)`, `ry = rx*0.7`; ring radius
  `min(n*STEP, fitX, fitY)` with fit from `RING_INSET` (bounds safety for large N).
- `sizeVariance = 0.85 + (hashHouseId(id) % 1000)/1000 * 0.30` (0.85..1.15).
- Decorative islets: **fixed** edge set independent of N, e.g.
  `(150,150),(1450,150),(150,850),(1450,850),(800,110),(800,890)` with small radii — deterministic and
  never generated from house count (append-stable).
- `islandPath` = reference `isl.path(m)` (`velaris-map.html:505-514`) using `islandRadius`.

**Create `src/components/map/terrain.ts`**
```ts
export interface GridLine { x1: number; y1: number; x2: number; y2: number }
export interface Star { x: number; y: number; r: number; opacity: number; twinkleSeconds?: number }
export interface CoastPath { islandId: string; d: string; kind: "coast" | "shallow" | "contour"; width: number; opacity: number; dash?: string }
export interface Mountain { x: number; y: number; scale: number }
export interface Tree { x: number; y: number; r: number }
export interface River { d: string }
export interface TerrainScene { grid: GridLine[]; stars: Star[]; coasts: CoastPath[]; mountains: Mountain[]; trees: Tree[]; rivers: River[] }

export const TERRAIN_CAPS = { stars: 260, mountains: 48, trees: 120, rivers: 4, gridStep: 200 } as const;
export const TERRAIN_SEED = 2026;
export function generateTerrain(layout: IslandLayout, seed?: number): TerrainScene;
```
Ports `velaris-map.html`: grid (524-525), stars with on-land rejection (529-534), shallows/coast/contours
(537-545: m 1.0/1.07/1.15 + contour at .72 when rx>100 and .45 when rx>300), mountains (577-595),
forest clusters (597-609), rivers (611-625). All caps enforced; all randomness from `mulberry32`.

**Edge cases:** 0 houses (heart + islets only; terrain still generates), 1 house (heart),
many houses (rings clamp inside world; positions remain unique via angle), no HL (first house at
heart), archived/disabled (layout treats them like any house — status only affects effects), unknown
large N (bounds test to 60).

**Tests (new)**
- `tests/unit/map-random.test.ts`: `hashHouseId` stable/non-negative/32-bit; `mulberry32`
  deterministic and in [0,1); `fxDelay` returns a negative-seconds string.
- `tests/unit/map-island-layout.test.ts`: determinism; HL pinned at `WORLD/2` and slot 0; first
  house at heart when no HL; append-stability (adding a house leaves existing islands/plots
  `toEqual`); unique plot positions for N=30; every `cx/cy` inside WORLD for N=60; `islandPath`
  starts `M`, ends `Z`, and has 160 segments; `isPointOnLand` true at an island centre.
- `tests/unit/map-terrain.test.ts`: determinism (`toEqual`); caps not exceeded (stars ≤260,
  mountains ≤48, trees ≤120, rivers ≤4); every star is off-land (`isPointOnLand(...,1.0)` false);
  coasts non-empty per island.

**Green gate:** `npx tsc --noEmit` + `npm test`. (Old modules untouched — `plot-layout.ts` remains
temporarily.)

---

### Stage B — Pure status mapping — **S**

**Deliverable:** exhaustive, pure runtime-status → effect-key mapping including the planning
variant and sticky/transient fail rules.

**Create `src/components/map/status-effects.ts`**
```ts
export type MapEffect = "idle" | "planning" | "working" | "need" | "paused" | "fail" | "dimmed";
export interface EffectInput {
  status: HouseStatus;
  runtimeStatus: HouseRuntimeStatus;
  kind?: HouseKind;
  planState?: HighLordPlanState;
  transientFail?: boolean;   // realtime fail/abort currently flashing
}
export const EFFECT_KEYS: readonly MapEffect[];
export const EFFECT_LABELS: Record<MapEffect, string>;   // Idle/Planning/Working/Needs you/Paused/Failed/Dimmed
export const LEGEND_EFFECTS: readonly MapEffect[];       // idle, planning, working, need, paused, fail (no dimmed)
export function effectForRuntime(runtimeStatus: HouseRuntimeStatus): MapEffect; // idle/planning/working/need/need/paused
export function effectForHouse(input: EffectInput): MapEffect;
export function isTransientFail(kind: CelebrationKind): boolean;              // failed | aborted
export function isStickyFail(h: { kind?: HouseKind; planState?: HighLordPlanState }): boolean; // high_lord && aborted
export function countEffects(houses: EffectInput[]): Record<MapEffect, number>;
```
Precedence (spec §4): `disabled|archived → dimmed` (wins) → `transientFail → fail` →
`stickyFail → fail` → `effectForRuntime`. `planning` is a **distinct key** (never collapsed to
`working`); `paused` is a distinct key rendered desaturated (Stage C), not omitted.
`EFFECT_COLORS` lives in `palette.ts` (Stage C) to avoid a status↔palette cycle; import it in the
legend/drawer, not here.

**Tests (new)** `tests/unit/map-status-effects.test.ts`: all six runtime statuses map correctly;
planning ≠ working; awaiting_approval and awaiting_input both → need; disabled/archived → dimmed for
every runtime; dimmed beats a transient fail; HL aborted → sticky fail; non-HL aborted planState →
not fail; transient fail → fail; `isTransientFail` true only for failed/aborted; `countEffects`
sums correctly.

**Green gate:** `tsc` + `npm test`.

---

### Stage C — React primitives & scoped CSS — **L**

**Deliverable:** the top-down citadel glyph, the per-state effect renderer (with `mini` for the
legend), and the map's scoped CSS. New files are additive; the old map keeps working, so the tree
stays green.

**Create `src/components/map/island-glyph.tsx`**
```tsx
export function IslandGlyph({ effect, sizeVariance, highLord }: { effect: MapEffect; sizeVariance: number; highLord: boolean }): JSX.Element;
```
Ports `buildGlyph` (`velaris-map.html:655-671`): soft ground shadow ellipse, octagon wall r15,
4 turrets, octagon roof r9, 8 ridges, state-coloured finial (`--fx-color`). `highLord` adds the gold
class. `octagonPath(r, rot?)` is a local helper (reference 647-654). This component is positioned by
its parent `<g transform="translate(x y) scale(...)">`.

**Create `src/components/map/effect.tsx`**
```tsx
export function EffectDefs(): JSX.Element;   // render ONCE at the map root
export function EffectUnder({ effect, mini, seed }: { effect: MapEffect; mini?: boolean; seed: number }): JSX.Element;
export function EffectOver({ effect, mini, seed }: { effect: MapEffect; mini?: boolean; seed: number }): JSX.Element;
export function EffectMini({ effect }: { effect: MapEffect }): JSX.Element;  // legend: under+glyph+over
export function CelebrationOverlay({ kind, reducedMotion, houseId }: { kind: CelebrationKind; reducedMotion: boolean; houseId: string }): JSX.Element;
export function BurningOverlay({ reducedMotion, houseId }: { reducedMotion: boolean; houseId: string }): JSX.Element;
```
- `EffectDefs` ports the reference `<defs>` (aura-idle/working/need/fail, sweep-need,
  sweep-need-mini) as **static radial gradients**. See §7 perf: `glow`/`soft`/`fogBlur`
  `feGaussianBlur` filters are **not** ported.
- `EffectUnder`/`EffectOver` mirror `FX` (`velaris-map.html:684-760`) one branch per effect key:
  `idle`, `working`, `need`, `planning` (calm moonlit rune ring, no gold — distinct from working),
  `paused` (idle art + `.is-paused` desaturated class), `fail`, `dimmed` (empty).
  `mini` reduces sweep radius, ripple smoke/ember counts exactly as the reference does.
- All animated nodes carry position on a parent `<g>`; the animated node itself only animates
  transform/opacity. Stagger via `fxDelay(...)` (deterministic), **never** `Math.random` (SSR
  hydration).
- `CelebrationOverlay`/`BurningOverlay` port the celebration + burning markup from the deleted
  `castle.tsx` (**preserve testids `city-celebration`, `city-static-celebration`,
  `map-castle-burning`, `map-castle-burning-static`**; reuse the existing `.burst-celebration`,
  `.static-celebration`, `.castle-burning*` CSS in globals.css).

**Modify `src/components/map/palette.ts`**
- Change the `hashHouseId` import to `./random`.
- Add `export const MAP_PALETTE = { abyss, sea, land, landHi, roof, ink, inkDim, label, text,
  textDim, idle, work, need, fail, ash, paused } as const;` (values from `velaris-map.html:40-64`).
- Add `export const EFFECT_COLORS: Record<MapEffect, string>` (imports `MapEffect` type) so
  JS-driven colour (finial, drawer pill, legend count) matches the CSS variables.
- Keep `paletteForHouse` + `CastlePalette` intact so `map-palette.test.ts` stays green; use
  `paletteForHouse(id).name` for a subtle per-house roof/island tint.

**Modify `src/app/globals.css`** (additive in this stage)
- Add a scoped block `.castle-map-viewport { --abyss: …; --sea: …; … }` (map palette as **local**
  custom properties per spec §7).
- Add `.map-coast`, `.map-shallow`, `.map-contour`, `.map-grid`, `.map-river`, `.map-mtn`,
  `.map-mtn-shade`, `.map-tree`, `.map-region`, `.map-sea-label`, `.map-star`/`.twinkle`, `.map-fog`,
  `.map-island-house`, `.map-house-label`, `.map-house-role`, `.map-glyph`/`.wall`/`.turret`/`.roof`/`.ridge`.
- Add all FX utility classes + keyframes from `velaris-map.html:142-165` (`fx-spin`, `.rev`,
  `fx-breathe`, `fx-gather`, `fx-emit`, `fx-ripple`, `fx-bob`, `fx-flicker`, `fx-smoke`, `fx-glow`,
  `fx-flash`, plus `spin/breathe/gather/emit/ripple/bob/flicker/smoke/glow/flash/twinkle/drift`).
  Every keyframe animates **transform/opacity only**.
- `paused` class desaturates; `dimmed` opacity only.

**Green gate:** `tsc` + `npm test` (new files are referenced by nothing yet; palette test still
passes).

---

### Stage D — Legend, drawer, and the castle-map rewrite — **L**

**Deliverable:** the composed map (terrain + islands + houses + cartouche + legend + zoom controls +
drawer) replacing the castle view, with the §6.1 click change and its e2e update.

**Create `src/components/map/map-legend.tsx`**
```tsx
export function MapLegend({ houses, filter, onFilter }: {
  houses: EffectInput[];
  filter: MapEffect | null;
  onFilter: (e: MapEffect | null) => void;
}): JSX.Element;
```
Ports the reference legend (`velaris-map.html:806-851`): a `<nav class="panel map-legend"
aria-label="Filter houses by status">`, one `<button aria-pressed>` per `LEGEND_EFFECTS` entry
(mini `<EffectMini/>` + label + live count from `countEffects`). Clicking toggles the filter;
active button shows counts; non-matching houses get dimmed by the map.

**Create `src/components/map/map-drawer.tsx`**
```tsx
export function MapDrawer({ house, effect, open, onClose }: {
  house: HouseCardData | null;
  effect: MapEffect;
  open: boolean;
  onClose: () => void;
}): JSX.Element | null;
```
- `<aside data-testid="map-drawer" role="…" aria-live="polite" aria-label="House details">` with a
  close button (`aria-label="Close details"`) and Escape-to-close (listener owned by `castle-map`).
- Shows name, `house.agent.role`, a status pill coloured by `EFFECT_COLORS[effect]`, the current
  task (fetch `/api/houses/${house.id}` on open → `HouseDetailDto.activeTask {title,status}`;
  fall back to list data while loading — mirrors `house-card.tsx:50-62`), and a pending-approval
  callout when `pendingApprovals > 0`.
- Actions are **links only**: `<Link href={/houses/${id}}>Open house →</Link>`, and
  `<Link href="/roost">Messenger Roost →</Link>` when a bird is pending. No inline approve/reply.

**Rewrite `src/components/map/castle-map.tsx`** (keep exported name `CastleMap`)
Keep verbatim: `useVelarisStream` wiring (`sequence` refetch + `on()`), `createCelebrationGuard`,
celebration timers + `CELEBRATION_MS`, camera state/clamp/default, viewport measurement, native
non-passive wheel, window pointer pan with `isDrag` threshold, `data-testid="map-viewport"` /
`map-world` / `map-controls`, zoom buttons named **"Zoom in" / "Zoom out" / "Reset view"**.
Add/change:
- Imports: `computeIslandLayout, WORLD` from `./island-layout`; `generateTerrain` from `./terrain`;
  `effectForHouse, countEffects, isTransientFail` from `./status-effects`; `MapLegend`, `MapDrawer`,
  `EffectDefs`, `EffectUnder/Over`, `IslandGlyph`.
- State: `selectedId: string | null`, `filter: MapEffect | null`, plus a **transient-fail map**
  `Record<string, true>` with per-house timers (same pattern as celebrations; fed by
  `celebrationFromFrame` frames where `isTransientFail(kind)`).
- House click → `select(houseId)` **unless** `gestureRef.current.justDragged` (drag suppression
  unchanged). Keyboard `Enter`/`Space` on the focused house → `select`. No `router.push` on click.
- Memoization: `layout = useMemo(() => computeIslandLayout(houses), [idSignature])` and
  `terrain = useMemo(() => generateTerrain(layout), [layout])`, where `idSignature` is the sorted
  house-id list — **not** the `houses` array (which changes on every SSE `sequence`). See §7.
- Render order inside the SVG/`map-world`: `EffectDefs` once → base `map-ground` → grid → stars →
  coasts/shallows/contours → terrain (mountains/trees/rivers) → fog → labels → compass → islands +
  houses. Each house `<g class="map-island-house" data-testid="map-castle-<id>" aria-label={name}
  data-state={effect} data-kind={kind ?? "agent"} data-plan-state={hl ? planState : undefined}
  data-dimmed="true" (when filtered out) role="button" tabIndex={0}>` wraps
  `EffectUnder → selection ring → IslandGlyph → EffectOver → hit area → label/role`, plus
  `CelebrationOverlay` / `BurningOverlay` / `map-bird-dot-<id>`.
- Cartouche: a panel with a serif "Velaris" wordmark **span (not a heading)** + live summary
  ("N houses need you, M working", ported `refreshMeta`); the page's `<h1>Map</h1>` chip stays.
- Zoom controls: keep the existing top-left pill and camera transform (reference `viewBox` zoom is
  **not** ported — `camera.ts` is retained per §6). Keep `map-empty` 0-house fallback.
- Reduced motion: pass `reducedMotion` into overlays; the global CSS clamp + hook already stop
  animation; static shapes remain legible via colour.
- `filter` applies `opacity` to non-matching houses (`.map-island-house[data-dimmed="true"]`) and
  the legend reflects `aria-pressed`.

**Modify `src/components/map/camera.ts`**: change `import { WORLD } from "./plot-layout"` →
`"./island-layout"`. No logic change.

**Modify `src/app/map/page.tsx`**: subtitle "The city at a glance" → "The archipelago at a glance"
(keep `<h1>Map</h1>` exactly).

**Modify `src/app/globals.css`**: remove the now-dead `.castle`, `.castle-*`, `.map-moon`,
`.map-grid` (old), `.map-star` (old), `.smoke-puff*`, `.messenger-bird*`, `.bird-dot` DOM rules as
appropriate, **but keep `.castle-burning*` + its keyframes** (reused by `BurningOverlay` and asserted
by `phase4-court.spec.ts`). Keep `.burst-celebration`/`.static-celebration`. Finalise the map block
from Stage C.

**Delete**: `src/components/map/castle.tsx`, `src/components/map/plot-layout.ts`,
`tests/unit/map-plot-layout.test.ts`.

**Modify `tests/unit/map-camera.test.ts`**: import `WORLD` from `@/components/map/island-layout`
and recompute the two hardcoded clamp expectations for 1600×1000 (e.g. the scale-2 x clamp becomes
`-2200`, and world-scaled extents in the floor tests use the new dimensions).

**Modify `tests/e2e/phase3-map.spec.ts`** (the intentional §6.1 change):
- Step 2 (house elements) unchanged: visible + `aria-label="Map House One"`; HL visible +
  `data-kind="high_lord"` + `data-state` matching `/idle/`.
- Replace "click navigates" with: click `c1` → `expect(page.getByTestId("map-drawer")).toBeVisible()`
  and the drawer contains "Map House One"; then click the link named `/Open house/` →
  `waitForURL('/houses/<h1.id>')` and heading "Map House One".
- Drag step: after the drag, assert the drawer is **not** visible (and URL still `/map`), in
  addition to the existing URL assertion.
- Zoom/reset + celebration + reduced-motion glyph steps unchanged.
- Add: legend filter (click a legend button, assert `aria-pressed="true"` and a non-matching
  `map-castle-<id>` has `data-dimmed="true"`), and drawer "Messenger Roost →" deep-link presence
  when `pendingApprovals > 0`.

**Green gate:** `npx tsc --noEmit` → `npm test` → free port 3000 → `npm run test:e2e`.

---

### Stage E — New test coverage & hardening — **M**

**Deliverable:** the new surfaces (legend filter, drawer deep-links, keyboard selection, reduced
motion, terrain caps) are covered; no production change.

**Modify `tests/e2e/phase3-map.spec.ts`** (add focused tests that share the sequential e2e DB):
- `legend filter dims non-matching houses and toggles off` (assert `aria-pressed` flip and
  `data-dimmed` on the idle house while filtering "working"; counts render).
- `keyboard selects a house` — focus `map-castle-<id>`, press Enter, assert drawer visible; Escape
  closes it.
- `drawer deep-links` — with a pending approval seeded for a house, assert both "Open house →" and
  "Messenger Roost →" links, and that `/roost` is reachable from the latter.
- `reduced-motion renders static fail` — add `velaris-reduced-motion`, seed a High Lord aborted
  plan, assert `map-castle-burning-static` is visible and the animated `map-castle-burning` count is 0.

**Unit tests** already added in Stages A/B; Stage E only extends them if coverage gaps are found
(e.g. `countEffects` for a mixed list).

**Green gate:** full gate sequence including e2e.

---

### Stage F — Docs — **S**

**Modify `README.md`**
- Line 19 (feature table): replace "shaded castles … outward-spiral placement" with the
  archipelago ("houses as citadels on a procedurally generated archipelago; pan/zoom; realtime
  status effects & celebrations").
- Lines 74-79 ("See the city"): rewrite to describe the top-down archipelago, the High Lord at the
  world heart (gold, burning overlay when aborted), click → drawer → "Open house →", legend filter,
  and the per-state effects (breathing idle, planning rune ring, working rune rings, magenta
  lighthouse sweep for need, embers for fail). Keep the drag/wheel/buttons sentence.

No AGENTS/architecture changes required (verified: no city-map references). Do **not** touch the
stale `docs/IMPLEMENTATION_PLAN.md`/`docs/ARCHITECTURE.md`.

**Green gate:** `tsc` + `npm test` (docs don't affect e2e, but run the full sequence before commit).

---

## 4. Reference-construct → target-module mapping (nothing silently dropped)

| Reference construct (`velaris-map.html`) | Target | Notes |
|---|---|---|
| `rng(seed)` mulberry32 (463-470) | `random.ts` `mulberry32` | Ported verbatim. |
| `anim()` durations + negative delay (473-479) | `random.ts` `fxDelay` + `effect.tsx` | Deterministic delay (no `Math.random`). |
| `ISLANDS` ellipses + Fourier `radius/path/inside` (484-520) | `island-layout.ts` | Procedural, sized to N; fixed heart + satellites + islets. |
| Grid (523-525) | `terrain.ts` `grid` | `gridStep` 200. |
| Stars + on-land rejection + twinkle (528-534) | `terrain.ts` `stars` | Cap 260; ~35% twinkle. |
| Shallows / coast / contours (537-545) | `terrain.ts` `coasts` | m 1.0/1.07/1.15 + .72/.45 contours. |
| Labels: region + `textPath` sea labels (549-567) | `island-layout.ts` (positions) + `castle-map.tsx` render | Fixed labels + `seaCurve` path. |
| `blocked()` keep-out (569-571) | `terrain.ts` internal | Avoids house glyphs/labels. |
| Mountains + ranges (577-595) | `terrain.ts` `mountains` | Cap 48. |
| Forests / tree clusters (597-609) | `terrain.ts` `trees` | Cap 120. |
| Rivers (611-625) | `terrain.ts` `rivers` | Cap 4, ≤120 steps. |
| Fog (382-386) | `terrain.ts`/`castle-map.tsx` fog ellipses | **Filter removed**; static radial-gradient fill. |
| Compass (630-642) | `castle-map.tsx` local `<Compass/>` | Static SVG. |
| `octagon` + `buildGlyph` (647-671) | `island-glyph.tsx` | Top-down citadel; state-coloured finial. |
| `spinGroup` + 4 `FX` functions (677-760) | `effect.tsx` `EffectUnder`/`EffectOver` | One branch per effect key; `mini` supported. |
| `buildFx` (762-767) | `effect.tsx` under/over split | Preserves z-order around the glyph. |
| `renderHouse` (775-801) | `castle-map.tsx` house `<g>` | Keeps `data-*`/testids/hit area/labels/flash. |
| Summary + legend (806-851) | `map-legend.tsx` + cartouche in `castle-map.tsx` | Live counts + `aria-pressed` filter. |
| Drawer states `idle/working/need/fail` (873-917) | `map-drawer.tsx` | Read-only; deep-links instead of inline actions. |
| Pan/zoom via `viewBox` + wheel/pointer (934-972) | **`camera.ts` retained** (world transform) | **Deliberate deviation** per spec §6: app keeps its tested camera; reference viewBox math is not ported. |
| `setHouseState` simulation (919-988) | **Not ported** | Explicit non-goal (§2). |

---

## 5. Preserved-contracts checklist (spec §8)

- [ ] `<h1>Map</h1>` remains the accessible page heading (`src/app/map/page.tsx`).
- [ ] Every house keeps `data-testid="map-castle-<id>"` and `aria-label={house.name}`.
- [ ] `data-state` present (values are the new effect keys; `working`/`idle` still asserted).
- [ ] `data-kind="high_lord"` on the High Lord; `data-plan-state="aborted"` where applicable.
- [ ] Zoom controls keep accessible names **"Zoom in" / "Zoom out" / "Reset view"**.
- [ ] `city-celebration` and `city-static-celebration` still render from the same realtime frames,
      guarded per task id, with reduced-motion static swap.
- [ ] `map-castle-burning` / `map-castle-burning-static` still render for the High Lord's aborted
      plan (asserted by `phase4-court.spec.ts:243-266`).
- [ ] `map-bird-dot-<id>` pending-approval indicator continues.
- [ ] `data-testid="map-viewport"`, `map-world`, `map-controls`; `map-world` keeps the
      `translate3d(...) scale(...)` inline transform that the zoom e2e parses.
- [ ] Drag still suppresses click/selection.
- [ ] `map-empty` fallback for zero houses retained (HL is seeded, so normally unreachable).

**The one intentional behaviour change** (spec §6.1): click on a house **opens the drawer**
instead of navigating. The drawer's **"Open house →"** link navigates to `/houses/<id>`.
`tests/e2e/phase3-map.spec.ts` is updated in Stage D accordingly — the heading/`data-*`/zoom/
celebration assertions are retained unchanged, so the test is re-contracted, not weakened.

---

## 6. Performance guardrails

- **transform/opacity only** in every keyframe; animated nodes carry position on a parent `<g>`.
- **Particle caps** in `TERRAIN_CAPS` (stars 260, mountains 48, trees 120, rivers 4) and per-house
  effect caps mirroring the reference (working: 3 motes + ≤6 sparks; need: 3 ripples + 1 sweep +
  1 badge; fail: ≤4 smoke + ≤7 embers; idle: 1 mote).
- **Filter decision (justified):** the reference uses `feGaussianBlur` in `glow`, `soft`, and
  `fogBlur` (362-371). We **drop all three**: SVG filters rasterise a large region per frame and
  break GPU compositing exactly when many elements animate. Replacements: the existing static
  radial-gradient auras/halos provide the glow; smoke/shadow use translucent circles; fog uses
  flat radial-gradient ellipses at low opacity. At most a CSS `filter: drop-shadow(...)` on the
  single finial per house may be used, and it is disabled under reduced-motion.
- **Terrain/layout memoization:** compute once per **house-id signature**, not per SSE frame
  (`houses` is replaced on every `sequence` tick). Runtime-state changes must not regenerate the
  archipelago or terrain.
- **Determinism = SSR-safe:** no `Math.random` in render (offsets/delays derive from `hashHouseId`).
- **Reduced motion disables animation** via the existing global clamps + hook; states remain legible
  through colour and static shapes.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Porting 1000 lines of vanilla SVG loses fidelity / adds jank | Deterministic generators land first (Stage A/B, unit-tested); React shell after; caps + transform/opacity only (spec §11). |
| Dynamic house count breaks hand-placed layout | Procedural seeded `island-layout` sized to N; HL pinned at the heart; append-stable ring scheme (Stage A). |
| New font/asset dependency | Reuse app fonts/tokens; scope map palette as local CSS variables (spec §7). |
| Existing e2e contracts break | §5 checklist; e2e updated in the same stage as the §6.1 change; `phase4-court`/`default-houses` untouched and must stay green. |
| `phase4-court` burning testids lost when deleting `castle.tsx` | `BurningOverlay` preserves both testids; verified Stage D gate runs the full e2e. |
| `WORLD` 1600×1000 breaks `map-camera.test.ts` numerics | Update import + recompute the two hardcoded clamp expectations in Stage D. |
| SVG `<defs>` id collisions when the legend also renders effects | Render `EffectDefs` exactly once at the map root; legend minis reference the same gradient ids. |
| Hydration mismatch from random FX delays/offsets | Deterministic `mulberry32`/`fxDelay` seeded from house id (no `Math.random` in render). |
| Drawer detail fetch adds load | Fetch `/api/houses/{id}` only on open; render from list data meanwhile. |

---

## 8. Standing gates (run after every stage that changes code)

1. `npx tsc --noEmit` — the typecheck gate (there is no typecheck script).
2. `npm test` — Vitest.
3. Free port 3000, then `npm run test:e2e` when UI/routes change.
4. **Never** `npm run lint` (no ESLint config; deprecated interactive prompt).
5. **No new dependencies** (no Google Fonts); no version bumps.
6. Import boundaries: `src/shared/**` React-free; `src/app` must not import `src/engine`;
   pure map modules (`random`, `island-layout`, `terrain`, `status-effects`) must stay React-free.
7. Engine is the single writer of execution/session/approval state; the map only reads and
   deep-links (no approval writes).
8. E2E uses temp DBs only (`db/velaris-e2e.db`, deleted by Playwright boot); never the real DB.

---

## 9. Open questions (recommended defaults)

| # | Question | Recommendation |
|---|---|---|
| 1 | World / viewBox size | **1600×1000** — 1:1 with the reference so ported constants transfer; update the camera test numerics (same 16:10 aspect as the old 1280×800). |
| 2 | Seed constant | **`WORLD_SEED = 2026`** (the reference seed) for the archipelago/terrain; per-island seed via `mulberry32(WORLD_SEED ^ hashHouseId(houseId))`. |
| 3 | Terrain memoization granularity | Memoize `computeIslandLayout` on a sorted **house-id signature** and `generateTerrain` on the layout; never on the `houses` array (SSE refetches). |
| 4 | Keep reference `feGaussianBlur` glow/soft/fog blur? | **No** — replace with static radial-gradient auras/halos and flat gradient fog (perf §6). |
| 5 | `paletteForHouse` after the glyph stops using it | **Keep** the export and use it for a subtle per-house roof/island tint, so `map-palette.test.ts` stays green. |
| 6 | `animation-map.statusToVisualState` becomes redundant | **Keep** `animation-map.ts` unchanged (celebrations + guard are still used); the new map uses `status-effects`. |
| 7 | Drawer's current-task data (list has no `activeTask`) | **Fetch `/api/houses/{id}` on open**, mirroring `house-card.tsx`; no API/schema change. |
| 8 | Roost per-house deep link | `/roost` — the page has no per-house query param. |
| 9 | Which states appear in the legend | `idle, planning, working, need, paused, fail` (exclude `dimmed`). |
| 10 | Decorative islets | Fixed edge set, independent of N (append-stable); cosmetic overlap acceptable. |

**Blocking unknowns:** none. All items above have safe defaults; the design is frozen. The only
"must not miss" items are already resolved in the plan: preserve the `map-castle-burning*` testids
when deleting `castle.tsx`, and refresh the two hardcoded `map-camera.test.ts` clamp values when
`WORLD` moves to 1600×1000.
