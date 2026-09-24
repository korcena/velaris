"use client";

/**
 * Castle map (Phase 3.1) — the full-screen interactive city view. Owns the
 * terrain, houses (fetched live keyed on the realtime stream), celebrations,
 * and the pan/zoom camera. Pan is handled with pointer events (a ~5px drag
 * threshold suppresses castle clicks); zoom via mouse wheel (native
 * non-passive listener on the viewport — avoiding the React onWheel passive
 * trap) and an on-screen control pill (zoom toward viewport centre).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Minus, RotateCcw } from "lucide-react";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import { apiFetch } from "@/lib/api-client";
import { celebrationFromFrame, createCelebrationGuard, type CelebrationKind } from "./animation-map";
import { computePlotLayout, WORLD } from "./plot-layout";
import { paletteForHouse } from "./palette";
import {
  clampPan,
  defaultCamera,
  isDrag,
  zoomAtPoint,
  zoomStep,
  type Camera,
} from "./camera";
import { useVelarisReducedMotion } from "./reduced-motion";
import type { HouseCardData } from "@/components/houses/house-card";
import { Castle } from "./castle";

const CELEBRATION_MS = 2600;

export function CastleMap() {
  const router = useRouter();
  const { on } = useVelarisStream();
  const reducedMotion = useVelarisReducedMotion();

  const [houses, setHouses] = useState<HouseCardData[]>([]);
  const [celebrations, setCelebrations] = useState<Record<string, { taskId: string; kind: CelebrationKind }>>({});
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [viewPort, setViewPort] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<Camera>(camera);
  cameraRef.current = camera;

  const guardRef = useRef(createCelebrationGuard());
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

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

  // Pan is tracked with window-level listeners (no pointer capture) so castle
  // `onClick` stays native — pointer capture would retarget the click to the
  // viewport and break navigation.
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

  // ---- Celebration subscription ----
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
    });
  }, [on]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
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

  // Fit the camera to the viewport once it is measured (cover scale, centred)
  // — the terrain then fills the screen edge-to-edge from the first frame.
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
      // Use the functional updater so rapid wheel events compose on the latest
      // camera instead of a stale cameraRef (which only refreshes on render).
      setCamera((cam) => zoomAtPoint(cam, cursor, factor, viewPort, WORLD));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewPort]);

  const plots = useMemo(() => computePlotLayout(houses), [houses]);

  const navigate = useCallback(
    (houseId: string) => {
      router.push(`/houses/${houseId}`);
    },
    [router],
  );

  // ---- Castle onClick wrapper: suppress navigation right after a drag ----
  const handleCastleNavigate = useCallback(
    (houseId: string) => {
      const g = gestureRef.current;
      if (g.justDragged) return;
      navigate(houseId);
    },
    [navigate],
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
    // Pointer motion/release is handled at window level; here we only mirror
    // the state clear so the JSX handler stays consistent.
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

  // ---- Control pill must not trigger pan ----
  const pillPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
  }, []);

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
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => zoomTo(1)}
          className="map-control-btn"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => zoomTo(-1)}
          className="map-control-btn"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Reset view"
          onClick={resetView}
          className="map-control-btn"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>

      {/* Base ground layer — fills the viewport at all times so panning to
          (or zooming at) the world's edge never reveals empty space. */}
      <div className="map-ground" aria-hidden="true" />

      {/* World (terrain details + castles), panned & zoomed via transform/opacity only. */}
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
        <Terrain />

        {plots.map((plot) => {
          const house = houses.find((h) => h.id === plot.houseId);
          if (!house) return null;
          const celebration = celebrations[house.id] ? celebrations[house.id].kind : null;
          return (
            <Castle
              key={house.id}
              plot={plot}
              house={house}
              palette={paletteForHouse(house.id)}
              celebration={celebration}
              reducedMotion={reducedMotion}
              onNavigate={handleCastleNavigate}
            />
          );
        })}

        {houses.length === 0 && (
          <div className="map-empty">
            <p className="font-serif-display text-xl text-foreground">
              The city&apos;s great houses lie empty — found one to light the skyline
            </p>
            <Link href="/houses" className="map-empty-link">
              Found a house
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

/** Decorative terrain: ground gradient is the viewport-covering base layer
 *  (see .map-ground); grid, roads, moon and stars pan/zoom with the world. */
function Terrain() {
  return (
    <div className="map-terrain" data-testid="map-terrain" aria-hidden="true">
      {/* Solid ground fill inside the world so the world canvas itself is
          opaque — the viewport base layer matches the same palette. */}
      <div className="map-grid" />
      <div className="map-moon" />
      <div className="map-stars">
        <span className="map-star" style={{ left: "12%", top: "8%" }} />
        <span className="map-star" style={{ left: "58%", top: "5%" }} />
        <span className="map-star" style={{ left: "80%", top: "14%" }} />
        <span className="map-star" style={{ left: "33%", top: "20%" }} />
        <span className="map-star" style={{ left: "70%", top: "26%" }} />
        <span className="map-star" style={{ left: "20%", top: "32%" }} />
      </div>
    </div>
  );
}
