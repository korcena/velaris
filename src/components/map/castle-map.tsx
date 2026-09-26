"use client";

/**
 * CastleMap (top-down archipelago redesign) — the full-screen interactive map.
 *
 * Each house is a citadel on a seeded island (`island-layout.ts`), surrounded
 * by procedural terrain (`terrain.ts`). Its runtime state drives a pure SVG/CSS
 * "magic" effect (`effect.tsx` via `status-effects.ts`). The shell keeps the
 * existing stream wiring, celebration guard/timers, reduced-motion handling
 * and the tested `camera.ts` pan/zoom — only the rendering changed.
 *
 * Spec §6.1 click semantics: a primary click (or Enter/Space on a focused
 * house) opens the drawer; the drawer's "Open house →" link navigates to the
 * house page. A drag still suppresses selection. Pan/zoom are unchanged.
 *
 * Performance (plan §6): layout is memoized on a sorted house-id signature (so
 * SSE refetches that replace the array never regenerate geometry); terrain is
 * memoized on the layout; all animation is transform/opacity only.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { Plus, Minus, RotateCcw } from "lucide-react";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import { apiFetch } from "@/lib/api-client";
import {
  celebrationFromFrame,
  createCelebrationGuard,
  type CelebrationKind,
} from "./animation-map";
import { WORLD, computeIslandLayout } from "./island-layout";
import { generateTerrain, type TerrainScene } from "./terrain";
import {
  clampPan,
  defaultCamera,
  isDrag,
  zoomAtPoint,
  zoomStep,
  type Camera,
} from "./camera";
import { useVelarisReducedMotion } from "./reduced-motion";
import { MAP_PALETTE, paletteForHouse } from "./palette";
import {
  TRANSIENT_FAIL_MS,
  countEffects,
  effectForHouse,
  isDimmedByFilter,
  isTransientFail,
  type EffectInput,
  type MapEffect,
} from "./status-effects";
import {
  BurningOverlay,
  CelebrationOverlay,
  EffectDefs,
  EffectOver,
  EffectUnder,
} from "./effect";
import { IslandGlyph } from "./island-glyph";
import { MapLegend } from "./map-legend";
import { MapDrawer } from "./map-drawer";
import {
  MAP_LABELS,
  clipLabel,
  houseRoleLabel,
  HOUSE_NAME_MAX,
  HOUSE_ROLE_MAX,
} from "./map-labels";
import type { HouseCardData } from "@/components/houses/house-card";

const CELEBRATION_MS = 2600;
const HIT_RADIUS = 30;

export function CastleMap() {
  const { on } = useVelarisStream();
  const reducedMotion = useVelarisReducedMotion();

  const [houses, setHouses] = useState<HouseCardData[]>([]);
  const [celebrations, setCelebrations] = useState<Record<string, { taskId: string; kind: CelebrationKind }>>({});
  const [transientFails, setTransientFails] = useState<Record<string, true>>({});
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [viewPort, setViewPort] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<MapEffect | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<Camera>(camera);
  cameraRef.current = camera;

  const guardRef = useRef(createCelebrationGuard());
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const failTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Pointer/motion-tracking state (refs, not state, to avoid re-render storms).
  const gestureRef = useRef<{
    active: boolean;
    dragging: boolean;
    justDragged: boolean;
    start: { x: number; y: number } | null;
    startCamera: Camera | null;
  }>({
    active: false,
    dragging: false,
    justDragged: false,
    start: null,
    startCamera: null,
  });

  // Pan is tracked with window-level listeners (no pointer capture) so house
  // `onClick` stays native — pointer capture would retarget the click to the
  // viewport and break selection.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g.active || !g.start || !g.startCamera) return;
      const cur = { x: e.clientX, y: e.clientY };
      if (!g.dragging) {
        if (isDrag(g.start, cur)) {
          g.dragging = true;
          g.justDragged = true;
        }
      }
      if (g.dragging) {
        const dx = cur.x - g.start.x;
        const dy = cur.y - g.start.y;
        setCamera(
          clampPan(
            { x: g.startCamera.x + dx, y: g.startCamera.y + dy, scale: g.startCamera.scale },
            viewPort,
            WORLD,
          ),
        );
      }
    };
    const onUp = () => {
      const g = gestureRef.current;
      if (!g.active) return;
      g.active = false;
      g.dragging = false;
      g.start = null;
      g.startCamera = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [viewPort]);

  // Escape closes the drawer (listener owned by the map per plan).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- Data load (live, refetch keyed on the realtime stream sequence) ----
  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ houses: HouseCardData[] }>(
        "/api/houses?includeArchived=true&includeHighLord=true",
      );
      setHouses(res.houses);
    } catch {
      setHouses([]);
    }
  }, []);

  const { sequence } = useVelarisStream();
  useEffect(() => {
    void load();
  }, [load, sequence]);

  // ---- Celebration + transient-fail subscription ----
  useEffect(() => {
    return on((frame) => {
      const trigger = celebrationFromFrame(frame);
      if (!trigger) return;
      if (!guardRef.current.consume(trigger)) return;

      setCelebrations((prev) => ({
        ...prev,
        [trigger.houseId]: { taskId: trigger.taskId, kind: trigger.kind },
      }));

      if (timersRef.current[trigger.houseId]) {
        clearTimeout(timersRef.current[trigger.houseId]);
      }
      timersRef.current[trigger.houseId] = setTimeout(() => {
        setCelebrations((prev) => {
          const next = { ...prev };
          delete next[trigger.houseId];
          return next;
        });
        delete timersRef.current[trigger.houseId];
      }, CELEBRATION_MS);

      // Transient fail: quest failures abort the derived status, so flash the
      // fail effect briefly then settle back (spec §4).
      if (isTransientFail(trigger.kind)) {
        setTransientFails((prev) => ({ ...prev, [trigger.houseId]: true }));
        if (failTimersRef.current[trigger.houseId]) {
          clearTimeout(failTimersRef.current[trigger.houseId]);
        }
        failTimersRef.current[trigger.houseId] = setTimeout(() => {
          setTransientFails((prev) => {
            const next = { ...prev };
            delete next[trigger.houseId];
            return next;
          });
          delete failTimersRef.current[trigger.houseId];
        }, TRANSIENT_FAIL_MS);
      }
    });
  }, [on]);

  useEffect(() => {
    const timers = timersRef.current;
    const failTimers = failTimersRef.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
      for (const t of Object.values(failTimers)) clearTimeout(t);
    };
  }, []);

  // ---- Viewport measurement (never clamp in render — only in handlers) ----
  const measure = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    setViewPort({ width: el.clientWidth, height: el.clientHeight });
  }, []);

  useLayoutEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // Fit the camera to the viewport once it is measured (contain scale, centred)
  // — the whole world (every house island) is visible from the first frame, with
  // the abyss-coloured ground layer filling any letterbox margin (D4).
  useLayoutEffect(() => {
    if (viewPort.width === 0 || viewPort.height === 0) return;
    setCamera((cam) =>
      cam.scale === 1 && cam.x === 0 && cam.y === 0
        ? defaultCamera(viewPort, WORLD)
        : cam,
    );
  }, [viewPort]);

  // ---- Native non-passive wheel listener (avoids React's passive onWheel) ----
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (viewPort.width === 0 || viewPort.height === 0) return;
      const rect = el.getBoundingClientRect();
      const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setCamera((cam) => zoomAtPoint(cam, cursor, factor, viewPort, WORLD));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewPort]);

  // ---- Memoized geometry: layout keyed on the sorted house-id signature ----
  const idSignature = useMemo(
    () => houses.map((h) => h.id).sort().join("|"),
    [houses],
  );
  // Intentionally depend on `idSignature`, not `houses` (which is replaced on
  // every SSE `sequence` tick) — plan Q3.
  const layout = useMemo(() => computeIslandLayout(houses), [idSignature]);
  const terrain = useMemo(() => generateTerrain(layout), [layout]);

  // ---- Derived per-house effect inputs (cheap; recomputed on refetch) ----
  const effectInputs = useMemo<EffectInput[]>(
    () =>
      houses.map((h) => ({
        status: h.status,
        runtimeStatus: h.runtimeStatus,
        kind: h.kind,
        planState: h.planState,
        transientFail: !!transientFails[h.id],
      })),
    [houses, transientFails],
  );
  const effectById = useMemo(() => {
    const map: Record<string, MapEffect> = {};
    houses.forEach((h, i) => {
      map[h.id] = effectForHouse(effectInputs[i]);
    });
    return map;
  }, [houses, effectInputs]);

  const summary = useMemo(() => {
    const counts = countEffects(effectInputs);
    const parts: Array<{ text: string; bold?: boolean }> = [];
    if (counts.need) {
      parts.push({ text: `${counts.need} house${counts.need === 1 ? "" : "s"} need you`, bold: true });
    }
    if (counts.fail) parts.push({ text: `${counts.fail} failed` });
    if (counts.working) parts.push({ text: `${counts.working} working` });
    if (counts.planning) parts.push({ text: `${counts.planning} planning` });
    return parts;
  }, [effectInputs]);

  const select = useCallback((houseId: string) => {
    const g = gestureRef.current;
    if (g.justDragged) return;
    setSelectedId(houseId);
  }, []);

  const handleHouseKeyDown = useCallback(
    (e: ReactKeyboardEvent<SVGGElement>, houseId: string) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSelectedId(houseId);
      }
    },
    [],
  );

  // ---- Pointer handlers (pan) ----
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    // Second pointer while one is active → treat as pinch guard (suppress clicks).
    if (g.active) {
      g.justDragged = true; // suppress any click from the second finger.
      return;
    }
    g.active = true;
    g.dragging = false;
    g.justDragged = false;
    g.start = { x: e.clientX, y: e.clientY };
    g.startCamera = { ...cameraRef.current };
    setDragging(true);
  }

  function endPointer() {
    const g = gestureRef.current;
    g.active = false;
    g.dragging = false;
    g.start = null;
    g.startCamera = null;
    setDragging(false);
  }

  const zoomTo = useCallback(
    (direction: 1 | -1) => {
      if (viewPort.width === 0 || viewPort.height === 0) return;
      setCamera(zoomStep(cameraRef.current, direction, viewPort, WORLD));
    },
    [viewPort],
  );

  const resetView = useCallback(() => {
    if (viewPort.width === 0 || viewPort.height === 0) {
      setCamera({ x: 0, y: 0, scale: 1 });
      return;
    }
    setCamera(defaultCamera(viewPort, WORLD));
  }, [viewPort]);

  const pillPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
  }, []);

  const selectedHouse = selectedId ? houses.find((h) => h.id === selectedId) ?? null : null;

  return (
    <div
      ref={viewportRef}
      className="castle-map-viewport"
      data-testid="map-viewport"
      data-dragging={dragging ? "true" : "false"}
      onPointerDown={onPointerDown}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      {/* Control pill (top-left, translucent) */}
      <div
        className="map-control-pill"
        onPointerDown={pillPointerDown}
        data-testid="map-controls"
      >
        <button type="button" aria-label="Zoom in" onClick={() => zoomTo(1)} className="map-control-btn">
          <Plus className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomTo(-1)} className="map-control-btn">
          <Minus className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Reset view" onClick={resetView} className="map-control-btn">
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>

      {/* Base ground layer — fills the viewport at all times. */}
      <div className="map-ground" aria-hidden="true" />

      {/* World (terrain details + island citadels), panned & zoomed. */}
      <div
        className="map-world"
        data-testid="map-world"
        style={{
          width: WORLD.width,
          height: WORLD.height,
          transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})`,
          transformOrigin: "0 0",
          willChange: "transform",
        }}
      >
        <svg
          className="map-svg"
          viewBox={`0 0 ${WORLD.width} ${WORLD.height}`}
          width={WORLD.width}
          height={WORLD.height}
          role="group"
          aria-label="Map of the Velaris agent houses"
        >
          <EffectDefs />

          {/* Ocean background. */}
          <rect
            x={-2000}
            y={-2000}
            width={WORLD.width + 4000}
            height={WORLD.height + 4000}
            className="map-ocean"
          />

          <TerrainLayer scene={terrain} />
          <Labels />
          <Compass />

          {/* Houses, drawn above the land. */}
          {layout.plots.map((plot) => {
            const house = houses.find((h) => h.id === plot.houseId);
            if (!house) return null;
            const effect = effectById[house.id] ?? "idle";
            const dimmed = isDimmedByFilter(effect, filter);
            const selected = selectedId === house.id;
            const seed = plot.slot * 17 + 3;
            const palette = paletteForHouse(house.id);
            return (
              <g
                key={house.id}
                className="map-island-house"
                data-state={effect}
                data-kind={house.kind ?? "agent"}
                data-plan-state={house.kind === "high_lord" ? house.planState ?? undefined : undefined}
                data-dimmed={dimmed ? "true" : "false"}
                data-selected={selected ? "true" : "false"}
                transform={`translate(${plot.x} ${plot.y})`}
              >
                <g className="fx fx-under">
                  <EffectUnder effect={effect} seed={seed} />
                </g>
                <circle
                  r={27}
                  fill="none"
                  stroke="var(--label)"
                  strokeWidth={1}
                  strokeDasharray="3 4"
                  className="map-sel fx-spin"
                  style={{ "--dur": "20s" } as CSSProperties}
                />
                <IslandGlyph
                  effect={effect}
                  sizeVariance={plot.sizeVariance}
                  highLord={house.kind === "high_lord"}
                  paletteName={palette.name}
                  seed={seed}
                />
                <g className="fx fx-over">
                  <EffectOver effect={effect} seed={seed} />
                </g>
                {/* Static focus/click target. Kept free of animated children so
                    its bounding box stays stable (Playwright clicks + a11y).
                    Carries the preserved §8 data-* contract for tests. */}
                <g
                  className="map-house-hit"
                  data-testid={`map-castle-${house.id}`}
                  data-state={effect}
                  data-kind={house.kind ?? "agent"}
                  data-plan-state={house.kind === "high_lord" ? house.planState ?? undefined : undefined}
                  data-dimmed={dimmed ? "true" : "false"}
                  data-selected={selected ? "true" : "false"}
                  role="button"
                  tabIndex={0}
                  aria-label={house.name}
                  onClick={() => select(house.id)}
                  onKeyDown={(e) => handleHouseKeyDown(e, house.id)}
                >
                  <circle r={HIT_RADIUS} fill="transparent" />
                </g>
                <text y={44} className="map-house-label">
                  {clipLabel(house.name, HOUSE_NAME_MAX)}
                </text>
                <text y={59} className="map-house-role">
                  {houseRoleLabel(house.agent.role, HOUSE_ROLE_MAX)}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Pending-approval bird dots + celebrations + burning overlays are
            HTML so they reuse the existing (ported) DOM CSS exactly. */}
        {layout.plots.map((plot) => {
          const house = houses.find((h) => h.id === plot.houseId);
          if (!house) return null;
          const celebration = celebrations[house.id]?.kind ?? null;
          const burning = house.kind === "high_lord" && house.planState === "aborted";
          const bird = (house.pendingApprovals ?? 0) > 0;
          if (!celebration && !burning && !bird) return null;
          return (
            <div
              key={`overlay-${house.id}`}
              className="map-house-overlay"
              style={{ left: plot.x, top: plot.y }}
              aria-hidden="true"
            >
              {bird ? (
                <span className="map-bird-dot" data-testid={`map-bird-dot-${house.id}`} />
              ) : null}
              {celebration ? (
                <CelebrationOverlay kind={celebration} reducedMotion={reducedMotion} houseId={house.id} />
              ) : null}
              {burning ? <BurningOverlay reducedMotion={reducedMotion} houseId={house.id} /> : null}
            </div>
          );
        })}

        {houses.length === 0 && (
          <div className="map-empty">
            <p className="font-serif-display text-xl text-foreground">
              The archipelago lies empty — found a house to light the islands
            </p>
            <Link href="/houses" className="map-empty-link">
              Found a house
            </Link>
          </div>
        )}
      </div>

      {/* Cartouche: title + live summary (the page's <h1>Map stays). */}
      <div className="map-cartouche">
        <span className="map-cartouche-wordmark">Velaris</span>
        <p className="map-cartouche-summary" data-testid="map-summary">
          {summary.length === 0 ? (
            "All houses are resting."
          ) : (
            <>
              {summary.map((part, i) => (
                <span key={i}>
                  {i > 0 ? ", " : ""}
                  {part.bold ? <b>{part.text}</b> : part.text}
                </span>
              ))}
              .
            </>
          )}
        </p>
      </div>

      <MapLegend houses={effectInputs} filter={filter} onFilter={setFilter} />

      <MapDrawer
        house={selectedHouse}
        effect={selectedHouse ? effectById[selectedHouse.id] ?? "idle" : "idle"}
        open={selectedHouse !== null}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}

/** Terrain: grid, stars, coasts, mountains, forests, rivers and fog. */
function TerrainLayer({ scene }: { scene: TerrainScene }) {
  return (
    <>
      {/* Grid */}
      <g className="map-grid">
        {scene.grid.map((l, i) => (
          <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
        ))}
      </g>

      {/* Stars reflected in the sea */}
      <g>
        {scene.stars.map((s, i) => (
          <circle
            key={i}
            cx={s.x}
            cy={s.y}
            r={s.r}
            className={`map-star${s.twinkleSeconds ? " map-twinkle" : ""}`}
            opacity={s.opacity}
            style={
              s.twinkleSeconds
                ? ({ "--dur": `${s.twinkleSeconds.toFixed(2)}s` } as CSSProperties)
                : undefined
            }
          />
        ))}
      </g>

      {/* Shallows, coast, contours */}
      <g>
        {scene.coasts.map((c, i) => {
          const common = {
            d: c.d,
            fill: "none" as const,
            strokeWidth: c.width,
            opacity: c.opacity,
            strokeDasharray: c.dash,
          };
          if (c.kind === "coast") {
            return <path key={i} d={c.d} className="map-coast" />;
          }
          return (
            <path
              key={i}
              {...common}
              className={c.kind === "shallow" ? "map-shallow" : "map-contour"}
            />
          );
        })}
      </g>

      {/* Mountains */}
      <g>
        {scene.mountains.map((m, i) => (
          <g key={i} transform={`translate(${m.x} ${m.y}) scale(${m.scale.toFixed(2)})`}>
            <path d="M0 -12 L9 4 L0 4 Z" className="map-mtn-shade" />
            <path d="M-10 4 L0 -12 L10 4" className="map-mtn" />
            <path d="M-3 -6 L0 -3 L2 -7" className="map-mtn" strokeWidth={0.7} />
          </g>
        ))}
      </g>

      {/* Forests */}
      <g>
        {scene.trees.map((t, i) => (
          <circle key={i} cx={t.x} cy={t.y} r={t.r} className="map-tree" />
        ))}
      </g>

      {/* Rivers */}
      <g>
        {scene.rivers.map((r, i) => (
          <path key={i} d={r.d} className="map-river" />
        ))}
      </g>

      {/* Fog (static gradient ellipses, no blur filter). */}
      <g>
        {scene.fog.map((f, i) => (
          <ellipse
            key={i}
            className={`map-fog${f.reverse ? " b" : ""}`}
            cx={f.cx}
            cy={f.cy}
            rx={f.rx}
            ry={f.ry}
            opacity={f.opacity}
            style={{ "--dur": `${f.driftSeconds}s` } as CSSProperties}
          />
        ))}
      </g>
    </>
  );
}

/**
 * Fixed place labels (region names + sea names). Anchors come from
 * `map-labels.ts`, where they are verified to stay inside the default views and
 * clear of islands/house labels for the separated house range (D2). The large
 * "Aurethil" region label is rendered as a subtle background watermark so it
 * never competes with a house label that happens to share its y-band.
 */
function Labels() {
  return (
    <g aria-hidden="true">
      {MAP_LABELS.map((l) =>
        l.kind === "region" ? (
          <text
            key={l.id}
            x={l.x}
            y={l.y}
            className={`map-region${l.id === "aurethil" ? " map-region-watermark" : ""}`}
            fontSize={l.size}
            transform={l.rotate ? `rotate(${l.rotate} ${l.x} ${l.y})` : undefined}
          >
            {l.text}
          </text>
        ) : (
          <text
            key={l.id}
            x={l.x}
            y={l.y}
            className="map-sea-label"
            fontSize={l.size}
            textAnchor="middle"
            transform={l.rotate ? `rotate(${l.rotate} ${l.x} ${l.y})` : undefined}
          >
            {l.text}
          </text>
        ),
      )}
    </g>
  );
}

/** Static compass (ported from the reference), in a verified-open ocean corner. */
function Compass() {
  const arms = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const L = i % 2 ? 26 : 48;
    const w = i % 2 ? 4 : 7;
    const tip = `${(Math.cos(a) * L).toFixed(2)} ${(Math.sin(a) * L).toFixed(2)}`;
    const lx = (Math.cos(a - Math.PI / 2) * w).toFixed(2);
    const ly = (Math.sin(a - Math.PI / 2) * w).toFixed(2);
    const rx = (Math.cos(a + Math.PI / 2) * w).toFixed(2);
    const ry = (Math.sin(a + Math.PI / 2) * w).toFixed(2);
    return { d1: `M0 0 L${lx} ${ly} L${tip} Z`, d2: `M0 0 L${rx} ${ry} L${tip} Z`, odd: i % 2 === 1 };
  });
  return (
    <g className="map-compass" transform={`translate(${830} ${800})`}>
      <circle r={36} fill="none" stroke={MAP_PALETTE.ink} strokeWidth={0.8} opacity={0.5} />
      <circle
        r={30}
        fill="none"
        stroke={MAP_PALETTE.ink}
        strokeWidth={0.5}
        opacity={0.4}
        strokeDasharray="1 3"
      />
      {arms.map((arm, i) => (
        <g key={i}>
          <path d={arm.d1} fill={MAP_PALETTE.ink} opacity={arm.odd ? 0.45 : 0.8} />
          <path d={arm.d2} fill={MAP_PALETTE.inkDim} opacity={0.7} />
        </g>
      ))}
      <circle r={3} fill={MAP_PALETTE.label} />
      <text
        y={-56}
        textAnchor="middle"
        fontFamily="var(--font-serif)"
        fontSize={16}
        fill={MAP_PALETTE.ink}
      >
        N
      </text>
    </g>
  );
}
