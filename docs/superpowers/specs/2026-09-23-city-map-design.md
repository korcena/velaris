# Velaris City Map — Design Spec

**Date:** 2026-09-23
**Status:** Approved by user
**Scope:** Phase 3.1 — replaces the dashboard skyline with a full-screen interactive city map.

## 1. Objective

The city becomes a real place. A new **"Map" page** (sidebar nav) renders a whimsical,
Sims-like bird's-eye (3/4 top-down) view of Velaris at night. Every house is drawn as a
**shaded castle** whose live status is visible from across the room. The user can pan and
zoom the map freely and click a castle to visit that house. The small SVG skyline on the
dashboard is removed — the map is *the* city view.

## 2. Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| D1 | Art direction: **chunky 3/4 perspective** (Sims/Zelda-like camera), full-screen page |
| D2 | Buildings are **castles**: crenellated keep + twin cone-roof towers + glowing windows + arched gate |
| D3 | Shading: **3-tone gradients** (light-left → base → dark-right) faking a single light source; drop shadows |
| D4 | Dashboard skyline **removed**; map page replaces it (dashboard keeps "Velaris" h1 + "Visit the Houses" link) |
| D5 | House placement: **deterministic auto-arrange** — founding-order plot grid along decorative streets, hash-based size/tint variance. No dragging castles, no schema/migration |
| D6 | **Pan**: drag anywhere (pointer events; ~5px movement threshold suppresses click) |
| D7 | **Zoom**: mouse wheel **and** on-screen buttons; controls are a translucent **pill pinned top-left** with `+` / `−` / `Reset view` |
| D8 | **Click navigates**: genuine click (no drag) on a castle → that house's detail page; castles keyboard-focusable (tab + Enter) |
| D9 | Status animations & once-per-task celebrations carried over from the Phase 3 skyline (retargeted selectors), including reduced-motion static glyphs |
| D10 | Zoom clamped (0.5×–2.5×); `Reset view` restores default pan/zoom |

## 3. Architecture

### 3.1 New files

```
src/app/map/page.tsx                      # full-screen map route ("use client")
src/components/map/castle-map.tsx          # canvas: terrain, roads, moon, castles;
                                          # owns SSE subscription + celebrations + camera
src/components/map/castle.tsx              # one house's castle (shaded geometry,
                                          # data-state, celebration overlays)
src/components/map/plot-layout.ts          # pure: deterministic plot grid + hash variance
src/components/map/palette.ts             # pure: per-house palette + gradient triples
src/components/map/camera.ts              # pure camera math: clamp zoom, pan bounds,
                                          # drag-threshold discrimination
src/components/map/animation-map.ts       # moved from components/city/ (unchanged logic)
src/components/map/reduced-motion.ts      # moved from components/city/ (unchanged logic)
```

### 3.2 Modified files

- `src/app/page.tsx` — remove `CitySkyline` mount + its heading; keep `h1` "Velaris" and
  the "Visit the Houses" link (existing e2e asserts both); add a Map QuickLink card.
- `src/shared/constants.ts` — `NAV_SECTIONS` gains `{ path: "/map", name: "Map",
  subtitle: "The city at a glance", icon: "Map" }` (icon name added to the icon map in
  `app-sidebar`).
- `src/app/globals.css` — status animation selectors retargeted from `.city-building` to
  `.castle`; smoke-puff origin moves to a tower chimney; celebration particle keyframes
  reused unchanged.
- `tests/e2e/navigation.spec.ts` (+ any spec touching the dashboard skyline) — updated
  assertions (see §7).

### 3.3 Retired

- `src/components/city/city-skyline.tsx`, `house-building.tsx` deleted after their logic
  is absorbed (pure modules move, not copied). `src/app/page.tsx` import removed.

### 3.4 Data flow (no API/engine changes)

`GET /api/houses` (enriched: `runtimeStatus`, `pendingApprovals`) refetched keyed on
`useVelarisStream().sequence`; `on(frame)` → `celebrationFromFrame` → once-per-task guard
→ transient celebration state per house. Reduced-motion via the moved hook. No new
endpoints, no schema changes, no engine work.

## 4. Visual spec

- **Camera**: fixed 3/4 top-down; pan via drag (translate), zoom via scale transform on
  a single wrapper (transform/opacity only — GPU-friendly, 60fps budget).
- **Terrain**: vertical gradient `#131c44 → #0e1534`; faint purple grid (40px, 7% alpha);
  two crossing gradient roads (`#46549c → #38448a`); moon disc top-right; sparse star
  specks. Purely decorative — roads do not connect houses logically.
- **Castles** (per approved mockup): keep with 5 crenellations; twin side towers with
  cone roofs; 2–4 glowing amber windows (`#ffd97a` + glow shadow); arched gate; drop
  shadow (blurred ellipse). Each house gets a stable palette from a rotation
  (purple, gold, teal, crimson, silver, …) picked by hash; gradients derive three tones
  per part. Size variance ±20% by hash; houses sort by founding order into street plots.
- **Status visuals** (CSS via `data-state` on `.castle`): idle = steady warm windows;
  planning = pulsing purple window glow; working = 3 teal smoke puffs above a tower
  chimney (staggered); awaiting_approval / awaiting_input = gold messenger-bird
  silhouette circling with wing flap; dimmed (disabled/archived) = 0.45 opacity, no
  animations. `pendingApprovals > 0` shows a small gold bird dot regardless of state.
- **Celebrations**: once per task (in-memory `Set<taskId>` guard, refresh-safe because
  `/api/stream` never replays history): completed = 12-particle burst (gold/teal/purple)
  ~2.2s; failed = 6-element crimson flicker; aborted = gray pulse. Reduced motion swaps
  bursts for static glyphs (`city-static-celebration` semantics preserved for e2e).
- **Chrome**: top-left translucent control pill (`+`, `−`, `Reset view`); small floating
  title chip; nothing else. Page fills viewport height minus the app chrome.

## 5. Interaction spec

- **Pan**: `pointerdown` → track movement; translate the map wrapper. Cursor: grab /
  grabbing. `Escape` does nothing (v1). Pan bounds keep terrain edge visible (clamped).
- **Zoom**: wheel → zoom toward cursor position (standard map feel), step ~1.1×;
  buttons zoom toward viewport center. Clamp 0.5×–2.5×. `Reset view` animates back to
  defaults (default: no animation — instant reset, v1).
- **Click vs drag**: pointer movement > 5px since `pointerdown` = drag (suppress click);
  otherwise release on a castle = navigate via `router.push`. Keyboard: focusable
  castles, Enter navigates, visible focus ring.
- **Reduced motion**: panning/zooming unaffected (user-initiated); only decorative
  animations are clamped by existing global rules + hook.

## 6. Error & edge handling

- 0 houses → empty state card centered on the map: "The city's great houses lie empty —
  found one to light the skyline" + link to `/houses`.
- SSE disconnected → last-known data persists; `sequence` refetch resumes on reconnect.
- Archived houses render dimmed (visible but inert).
- Wheel over the map must not scroll the page (`preventDefault` + `overscroll` rules).

## 7. Testing

- **Unit** (`tests/unit/map-*.test.ts`): `plot-layout` (determinism, unique slots, street
  wrap, variance bounds), `palette` (stable assignment, valid gradient triples),
  `camera` (zoom clamp, pan bounds, drag-threshold true/false cases).
- **E2E** (`tests/e2e/phase3-map.spec.ts`): map page renders a castle per created house
  (data-testid + aria-label); click navigates to house detail; drag does NOT navigate;
  seeded running session → `data-state="working"`; seeded `task_completed` event →
  celebration visible then clears; reduced-motion → static glyph; zoom buttons change
  transform scale; reset restores it. Existing specs updated: dashboard no longer asserts
  skyline; navigation spec asserts the new Map section renders.
- **Gates**: `npx tsc --noEmit` → `npm test` → `npm run test:e2e`.

## 8. Out of scope (v1)

Dragging castles, persisted camera state, camera rotation, pinch-zoom (only if it falls
out of pointer math for free), minimap, castle interiors, logical roads between houses,
High Lord special-castle treatment (Phase 4 may gold-plate the High Lord castle),
mobile-specific gestures beyond basic pointer support, terrain editing.