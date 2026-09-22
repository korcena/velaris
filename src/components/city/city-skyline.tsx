"use client";

/**
 * City skyline (Phase 3) — an SVG night-skyline of all your houses, mounted on
 * the dashboard (src/app/page.tsx). Fetches houses (enriched with runtimeStatus
 * + pendingApprovals), subscribes to the realtime stream for celebration
 * triggers, and renders each house as a <HouseBuilding>.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import { apiFetch } from "@/lib/api-client";
import {
  celebrationFromFrame,
  createCelebrationGuard,
  type CelebrationKind,
} from "@/components/city/animation-map";
import { computeCityLayout } from "@/components/city/layout";
import { useVelarisReducedMotion } from "@/components/city/reduced-motion";
import type { HouseCardData } from "@/components/houses/house-card";
import { HouseBuilding } from "./house-building";

const CELEBRATION_MS = 2600;

export function CitySkyline() {
  const { on } = useVelarisStream();
  const reducedMotion = useVelarisReducedMotion();

  const [houses, setHouses] = useState<HouseCardData[]>([]);
  const [celebrations, setCelebrations] = useState<Record<string, { taskId: string; kind: CelebrationKind }>>(
    {},
  );

  const guardRef = useRef(createCelebrationGuard());
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ houses: HouseCardData[] }>("/api/houses?includeArchived=true");
      setHouses(res.houses);
    } catch {
      setHouses([]);
    }
  }, []);

  const { sequence } = useVelarisStream();
  useEffect(() => {
    void load();
  }, [load, sequence]);

  // Subscribe to realtime frames → celebration triggers.
  useEffect(() => {
    return on((frame) => {
      const trigger = celebrationFromFrame(frame);
      if (!trigger) return;
      if (!guardRef.current.consume(trigger)) return;

      setCelebrations((prev) => ({
        ...prev,
        [trigger.houseId]: { taskId: trigger.taskId, kind: trigger.kind },
      }));

      // Clear after the burst plays.
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

  // Cleanup timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, []);

  const plots = useMemo(() => computeCityLayout(houses), [houses]);
  const houseById = useMemo(() => new Map(houses.map((h) => [h.id, h])), [houses]);

  return (
    <section>
      <PageHeader
        title="The City"
        subtitle="Your houses at night — click a building to enter."
      />
      {houses.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card/30 p-10 text-center">
          <p className="font-serif-display text-xl text-foreground">
            The city&apos;s great houses lie empty — found one to light the skyline
          </p>
          <Link
            href="/houses"
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Found a house
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-card/30 p-4">
          <svg
            viewBox="0 0 1000 420"
            className="h-auto w-full"
            role="img"
            aria-label="Velaris city skyline"
          >
            {/* Starfield / sky */}
            <rect x="0" y="0" width="1000" height="420" fill="#0b1026" />
            <Background />

            {plots.map((plot) => {
              const house = houseById.get(plot.houseId);
              if (!house) return null;
              const celebration = celebrations[house.id] ? celebrations[house.id].kind : null;
              return (
                <HouseBuilding
                  key={house.id}
                  plot={plot}
                  house={house}
                  celebration={celebration}
                  reducedMotion={reducedMotion}
                />
              );
            })}
          </svg>
        </div>
      )}
    </section>
  );
}

/** Static night background: moon disc + distant spire/hill silhouettes. */
function Background() {
  return (
    <g className="skyline-background">
      {/* Moon */}
      <circle cx="840" cy="80" r="38" fill="#1a2142" />
      <circle cx="840" cy="80" r="38" fill="none" stroke="#2a3360" strokeWidth="2" />
      {/* Distant hills */}
      <path d="M0 340 L 90 260 L 170 320 L 250 250 L 340 330 L 1000 280 L 1000 420 L 0 420 Z" fill="#12173a" />
      <path d="M0 380 L 160 300 L 300 370 L 460 290 L 640 360 L 820 300 L 1000 350 L 1000 420 L 0 420 Z" fill="#1a2150" />
      {/* Distant spires */}
      <path d="M120 300 L 128 210 L 136 300 M 240 300 L 248 190 L 256 300 M 480 300 L 490 200 L 500 300" stroke="#232c60" strokeWidth="3" fill="none" />
      <path d="M720 300 L 728 230 L 736 300 M 900 300 L 908 210 L 916 300" stroke="#232c60" strokeWidth="3" fill="none" />
    </g>
  );
}
