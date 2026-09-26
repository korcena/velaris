# Design — Top-Down Archipelago Map

**Date:** 2026-09-26
**Status:** Approved (design); implementation plan pending
**Reference:** `/home/kate/Downloads/velaris-map.html` (standalone design reference, 1000 lines)

## 1. Objective

Replace the current isometric shaded-castle city view at `/map` with a **top-down fantasy
archipelago** in which each house is a citadel on its own island, and its runtime state is
shown through top-down SVG/CSS "magic" effects (breathing auras, rune rings, lighthouse
sweeps, embers). The result should feel like a painted fantasy map while remaining driven by
live house data and preserving the existing navigation, realtime, and accessibility contracts.

## 2. Non-goals

- Not changing the house detail page, Roost, Court, or any approval/steer logic.
- Not importing the reference's Google Fonts or any new dependency (see §7).
- Not adding the reference's "Simulate activity" developer toggle.
- Not changing the runtime-status model, the realtime stream, or the engine.
- Not building a second copy of approval/chat actions inside the map (drawer deep-links).

## 3. Reference: what it provides

The reference is a single self-contained HTML page with:

- A seeded procedural archipelago: `ISLANDS` ellipses + Fourier `radius()` coastlines,
  shallows/contours, a star field, rivers, mountains, forests, fog, a compass, place labels.
- A top-down house glyph (octagon wall + turrets + ridged roof + glowing finial).
- **Four state effects**, one pure function per state:
  - `idle` — moonlight blue, slow breathing aura, dotted ward ring, one orbiting mote.
  - `working` — starfire gold, two counter-rotating rune rings, inward-gathering energy,
    three fast motes, outward sparks.
  - `need` — magenta lighthouse sweep beam, expanding ripples, bobbing `!` sigil.
  - `fail` — ember red, flickering dim aura, cracked roof, smoke, scattered embers.
- Chrome: cartouche (title + live summary), a status legend that filters/dims, zoom controls,
  a slide-in detail drawer with per-state actions, pan/zoom via `viewBox`.
- All effects are pure SVG + CSS keyframes (no canvas, no libraries); animated elements carry
  position on a parent `<g>` so CSS transforms never fight SVG `transform`; full
  `prefers-reduced-motion` support.

## 4. State mapping (approved)

The app has six runtime statuses plus dimmed/inactive. Mapping onto the reference effects:

| App status | Effect | Notes |
|---|---|---|
| `idle` | idle | moonlight-blue breathing aura |
| `planning` | **planning variant** | distinct: a slow, moonlit rune ring — calmer than `working`, no gold — so planning is legible at a glance |
| `working` | working | starfire gold, counter-rotating rings, motes/sparks |
| `awaiting_approval` | need | magenta sweep + bobbing `!` |
| `awaiting_input` | need | same effect (a question needs you too) |
| `paused` | idle (desaturated) | calm but visibly set aside |
| disabled / archived | dimmed | no animation, reduced opacity |
| High Lord with `planState='aborted'` | **sticky** fail | persists from the real `planState` signal while the plan is aborted |
| quest `task_failed` / `session_aborted` | **transient** fail | ember flash on the realtime frame, then settle back to the derived status |

Rationale: `planning` gets its own variant because "busy planning" vs "busy executing" is
meaningful and cheap to distinguish; ordinary failures are transient because the runtime
status never *stays* failed (the session falls back to `idle`), whereas the High Lord's
aborted plan has a genuine persisted signal to be sticky about.

## 5. Dynamic data → procedural archipelago

The reference hard-places 7 houses on 12 islands; the app has **dynamic** houses (10 default
ACOTAR houses + the High Lord + any the user adds). Therefore a new **pure module**,
`src/components/map/island-layout.ts`, computes a deterministic (seeded) archipelago sized to
the house count:

- The **High Lord is pinned at the world heart** (mirroring the current map's rule and the
  "High Lord at the city centre" decision).
- Other houses occupy satellite islands, spiralling outward, allocated **in founding order**.
- Layout is **append-stable**: adding a house never moves existing houses.
- Coastline/terrain generation is ported as **seeded pure functions** (stable between loads),
  with the reference's Fourier coastline approach.
- All geometry is React-free and unit-testable, mirroring the current `plot-layout.ts`.

## 6. Chrome & interaction (option C)

- **Cartouche** — "Velaris" title plus a live summary (e.g. "2 houses need you, 3 working").
- **Legend** — one button per state with a mini glyph and a live count; clicking filters
  (dims non-matching houses). Reuses the reference's behaviour.
- **Zoom controls** — zoom in / out / reset (existing camera module, retained).
- **Lightweight drawer** (on selecting a house) — house name, agent role, status pill, the
  current task title/status, and a pending-approval callout. Its buttons **navigate to the
  existing house page / Messenger Roost** rather than performing approvals inline. This avoids
  duplicating approval/steer logic that already lives on those surfaces.

### 6.1 Click semantics (resolves a direct conflict with the existing e2e contract)

Today clicking a castle **navigates straight to `/houses/<id>`**, and
`tests/e2e/phase3-map.spec.ts` asserts exactly that (with drag suppressing navigation). The
reference opens a drawer on click instead. These cannot both be primary, so:

- **Primary click = open the drawer** (the redesigned map's behaviour; selecting is the
  natural act on a map).
- The drawer's actions panel contains an explicit **"Open house →"** link to `/houses/<id>`
  (and a "Messenger Roost →" link when a bird is pending), preserving the deep-link path.
- **Keyboard**: `Enter`/`Space` on a focused house opens the drawer (focus is preserved).
- **Drag still suppresses click** (unchanged), and pan/zoom are unchanged.
- The e2e spec is **updated** to the new contract: click → drawer opens (assert drawer
  visible + the correct house); clicking "Open house →" navigates to `/houses/<id>`; drag
  still suppresses. The heading/`data-*`/zoom assertions stay intact. This is an intentional,
  documented behaviour change, not a weakened test.

If you would rather keep click = navigate and open the drawer only via a secondary affordance
(e.g. a small info button), say so at review and I will invert §6.1.

## 7. Fonts, palette & performance

- **Fonts:** reuse the app's existing fonts and design tokens. The reference's Google Fonts
  (IM Fell English, Alegreya Sans) are **not** imported — that would add an external network
  dependency/asset, contrary to the project's constraints.
- **Palette:** the reference's map palette (abyss/sea/land/ink/idle/working/need/fail) is
  scoped as local CSS custom properties for the map, so it does not disturb the app theme.
- **Performance:** cap generated stars/particles; every animation uses **transform/opacity
  only**; `prefers-reduced-motion` (and the app's `velaris-reduced-motion` class) disables all
  animation while keeping states legible through colour and static shapes.

## 8. Preserved contracts (so existing tests/behaviour keep working)

The existing e2e suite asserts on these; they must remain:

- The page heading remains named **"Map"**.
- Each house keeps `data-testid="map-castle-<id>"`, an `aria-label` of the house name,
  `data-state`, `data-kind` (`high_lord` for the High Lord), and `data-plan-state` where
  applicable.
- Zoom controls keep accessible names ("Zoom in", "Zoom out", "Reset view").
- Celebrations (`city-celebration` / `city-static-celebration`) and the pending-approval bird
  indicator continue to function, driven by the same realtime frames.
- House selection opens the drawer (§6.1); the drawer's "Open house →" link navigates to the
  house page. The e2e spec is updated to this contract (see §6.1) while retaining the
  heading/`data-*`/zoom/celebration assertions.

## 9. Architecture / modules

```
src/components/map/
  island-layout.ts     NEW  pure: seeded archipelago + house placement (deterministic, append-stable)
  status-effects.ts    NEW  pure: runtime status -> effect key (+ planning variant, sticky/transient fail)
  terrain.ts           NEW  pure: seeded stars/shallows/contours/rivers/mountains/forests
  island-glyph.tsx     NEW  top-down citadel glyph (React)
  effect.tsx           NEW  per-state effect renderer (React, CSS-driven)
  map-legend.tsx       NEW  legend + counts + filter
  map-drawer.tsx       NEW  lightweight drawer (deep-links)
  castle-map.tsx       REWRITE  orchestrates map, stream, camera, selection
  castle.tsx           REPLACED by island-glyph/effect
  camera.ts            KEEP  (tested pan/zoom)
  animation-map.ts     KEEP  (celebrations, guards)
  palette.ts           EXTEND with the reference's map palette tokens
  reduced-motion.ts    KEEP
```

Pure modules (layout, status mapping, terrain) are React-free and unit-tested; effects are
CSS-keyframe driven so reduced-motion handling stays declarative.

## 10. Testing

**Unit (Vitest, node):**
- `island-layout`: determinism (same input → same geometry), High Lord pinned at the heart,
  append-stability (adding a house does not move existing ones), bounds safety for large N.
- `status-effects`: every runtime status maps to the right effect; `planning` variant is
  distinct from `working`; disabled/archived → dimmed; High Lord aborted → sticky fail;
  transient fail resolution.
- terrain generation determinism and caps.

**E2E (Playwright):** the updated `/map` still satisfies the existing assertions (heading
"Map", `map-castle-<id>` visibility + `aria-label`, `data-state="working"` for a running
session, `data-kind="high_lord"`, zoom controls, single celebration per completed task,
reduced-motion static celebration), plus the legend filter and drawer deep-link.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Porting 1000 lines of vanilla SVG into React/CSS loses fidelity or introduces jank | Port the deterministic generators as pure functions first (unit-tested), then the React shell; cap particles; transform/opacity only. |
| Dynamic house count breaks the hand-placed reference layout | Procedural, seeded, append-stable `island-layout` sized to N; High Lord pinned at centre. |
| New external font/asset dependency | Reuse existing fonts/tokens; scope the map palette as local CSS variables. |
| Existing e2e contracts break | §8 explicitly preserves heading, `data-*`, test ids, and controls; e2e updated but not weakened. |
| Performance budget (AGENTS.md) | Particle caps; no canvas; reduced-motion disables animation. |

## 12. Open questions

None outstanding — all decisions resolved during brainstorming:

- Scope: **(C)** visual redesign + lightweight deep-linking drawer.
- State mapping: distinct **planning** variant; **transient** fail for quests; **sticky** fail
  for the High Lord's aborted plan.
- Fonts: **reuse app fonts** (no Google Fonts import).
- Palette: scoped local CSS variables.
