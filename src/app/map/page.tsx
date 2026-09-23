"use client";

/**
 * Map (Phase 3.1) — full-screen interactive city map. Renders the castle map
 * with a floating title chip ("Map") that provides the accessible heading name
 * the nav tests assert on.
 */

import { CastleMap } from "@/components/map/castle-map";

export default function MapPage() {
  return (
    // Breaks out of main's px-6/py-6 (md:px-10) padding so the map fills the
    // right panel edge-to-edge: full width under the sidebar, full height
    // from below the h-14 topbar to the bottom of the viewport.
    <div className="relative -mx-6 -my-6 h-[calc(100dvh-3.5rem)] min-w-0 md:-mx-10">
      <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 text-center">
        <h1 className="inline-block rounded-full border border-border/60 bg-card/60 px-4 py-1 font-serif-display text-lg text-foreground backdrop-blur">
          Map
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">The city at a glance</p>
      </div>
      <CastleMap />
    </div>
  );
}
