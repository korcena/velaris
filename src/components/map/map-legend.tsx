"use client";

/**
 * MapLegend — one filter button per `LEGEND_EFFECTS` entry, ported from the
 * reference legend (velaris-map.html:806-851). Each button shows a mini glyph
 * (a compact version of the effect) plus a live count from `countEffects`.
 * Clicking toggles the filter; the active button is `aria-pressed`.
 *
 * `dimmed` is intentionally excluded (plan Q9): it is a "house is inactive"
 * state, not a status you would filter for.
 */

import { EffectMini } from "./effect";
import { EFFECT_LABELS, LEGEND_EFFECTS, countEffects, type EffectInput, type MapEffect } from "./status-effects";

export function MapLegend({
  houses,
  filter,
  onFilter,
}: {
  houses: EffectInput[];
  filter: MapEffect | null;
  onFilter: (e: MapEffect | null) => void;
}) {
  const counts = countEffects(houses);

  return (
    <nav className="map-legend" aria-label="Filter houses by status">
      <div className="map-legend-items">
        {LEGEND_EFFECTS.map((effect) => {
          const pressed = filter === effect;
          const label = EFFECT_LABELS[effect];
          return (
            <button
              key={effect}
              type="button"
              aria-pressed={pressed}
              title={`Highlight ${label.toLowerCase()} houses`}
              data-testid={`map-legend-${effect}`}
              onClick={() => onFilter(pressed ? null : effect)}
            >
              <EffectMini effect={effect} />
              <span>{label}</span>
              <span className="map-legend-count">{counts[effect]}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
