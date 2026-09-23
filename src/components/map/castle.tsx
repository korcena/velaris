"use client";

/**
 * Castle (Phase 3.1) — a single house drawn as a chunky 3/4-perspective castle
 * on the city map. Rendered as CSS-DOM divs (not SVG) so it gets native focus,
 * click and accessibility, driven by inline CSS variables from its palette.
 * Status visuals (working smoke, awaiting messenger bird, pending bird-dot,
 * celebrations) reuse the Phase 3 class names retargeted to `.castle` in
 * globals.css.
 */

import type { CSSProperties, KeyboardEvent } from "react";
import { statusToVisualState, type CelebrationKind } from "./animation-map";
import { hashHouseId, type CastlePlot } from "./plot-layout";
import type { CastlePalette } from "./palette";
import type { HouseCardData } from "@/components/houses/house-card";

const SMOKE_PUFFS = [0, 1, 2];
const FIREWORK_PARTICLES = Array.from({ length: 12 }, (_, i) => i);
const FAILURE_FLICKERS = Array.from({ length: 6 }, (_, i) => i);

/** CSS variables derived from the palette (faked single light source). */
function paletteVars(palette: CastlePalette): CSSProperties {
  return {
    "--keep-light": palette.keep.light,
    "--keep-base": palette.keep.base,
    "--keep-dark": palette.keep.dark,
    "--roof-light": palette.roof.light,
    "--roof-base": palette.roof.base,
    "--roof-dark": palette.roof.dark,
    "--tower-light": palette.tower.light,
    "--tower-base": palette.tower.base,
    "--tower-dark": palette.tower.dark,
    "--window-glow": palette.windowGlow,
    "--window-glow-soft": palette.windowGlowSoft,
  } as CSSProperties;
}

export function Castle({
  plot,
  house,
  palette,
  celebration,
  reducedMotion,
  onNavigate,
}: {
  plot: CastlePlot;
  house: HouseCardData;
  palette: CastlePalette;
  celebration: CelebrationKind | null;
  reducedMotion: boolean;
  onNavigate: (houseId: string) => void;
}) {
  const state = statusToVisualState(house);
  const baseStyle: CSSProperties = {
    left: plot.x,
    top: plot.y,
    transform: `translate(-50%, -50%) scale(${plot.sizeVariance})`,
    ...paletteVars(palette),
  };

  function go() {
    onNavigate(house.id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  }

  return (
    <div
      className="castle outline-none focus-visible:ring-2 focus-visible:ring-velaris-gold focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      style={baseStyle}
      data-state={state}
      data-testid={`map-castle-${house.id}`}
      role="button"
      tabIndex={0}
      aria-label={house.name}
      onClick={go}
      onKeyDown={onKeyDown}
    >
      {/* Transparent interactive hit-target (children below are decorative). */}
      <div className="castle-hit" aria-hidden="true" />

      {/* Blurred-ellipse drop shadow on the ground */}
      <div className="castle-shadow" aria-hidden="true" />

      {/* Twin cone-roof side towers */}
      <Tower side="left" />
      <Tower side="right" />

      {/* Main crenellated keep */}
      <div className="castle-keep">
        <div className="castle-crenellation" aria-hidden="true">
          {SMOKE_PUFFS.map((i) => (
            <span key={i} className="castle-merlon" />
          ))}
        </div>
        <div className="castle-windows">
          {Array.from({ length: plot.windowCount }, (_, i) => (
            <span key={i} className="castle-window" />
          ))}
        </div>
        <div className="castle-gate" aria-hidden="true" />
      </div>

      {/* Tower chimney (smoke origin when working) */}
      <div className="castle-chimney" aria-hidden="true" />

      {/* Working smoke puffs above the chimney. */}
      {state === "working" &&
        SMOKE_PUFFS.map((i) => (
          <div
            key={i}
            className="smoke-puff"
            style={{ ["--puff-i" as string]: i } as CSSProperties}
            aria-hidden="true"
          >
            <div className="smoke-puff-circle" />
          </div>
        ))}

      {/* Messenger bird silhouette when awaiting approval / input. */}
      {(state === "awaiting_approval" || state === "awaiting_input") && (
        <div className="messenger-bird" aria-hidden="true">
          <div className="bird-body" />
          <div className="bird-wing-left" />
          <div className="bird-wing-right" />
        </div>
      )}

      {/* Pending-approval gold bird dot, regardless of state. */}
      {(house.pendingApprovals ?? 0) > 0 && (
        <div
          className="bird-dot"
          data-testid={`map-bird-dot-${house.id}`}
          aria-hidden="true"
        />
      )}

      {/* Celebration overlay */}
      {celebration
        ? reducedMotion
          ? <StaticCelebration kind={celebration} />
          : <BurstCelebration kind={celebration} houseId={house.id} />
        : null}

      {/* House name label beneath the castle */}
      <div className="castle-label">{house.name}</div>
    </div>
  );
}

/** A twin side tower: a tapered shaft plus a cone roof (clip-path triangle). */
function Tower({ side }: { side: "left" | "right" }) {
  return (
    <div className={`castle-tower castle-tower-${side}`} aria-hidden="true">
      <div className="castle-tower-roof" />
      <div className="castle-tower-shaft" />
    </div>
  );
}

/** Reduced-motion static glyph (gold star / crimson x / gray bars). */
function StaticCelebration({ kind }: { kind: CelebrationKind }) {
  return (
    <div
      data-testid="city-static-celebration"
      className="static-celebration"
      role="img"
      aria-hidden="true"
    >
      {kind === "completed" && <span className="static-glyph static-glyph-star">✦</span>}
      {kind === "failed" && <span className="static-glyph static-glyph-x">✕</span>}
      {kind === "aborted" && (
        <span className="static-glyph static-glyph-bars">❚❚</span>
      )}
    </div>
  );
}

/** Animated burst (12 firework particles / 6 flickers / aborted bars). */
function BurstCelebration({ kind, houseId }: { kind: CelebrationKind; houseId: string }) {
  if (kind === "completed") {
    // Deterministic directional offsets from house+kind, fanned per particle.
    const dx = (hashHouseId(`${houseId}-${kind}-fx`) % 60) - 30;
    const dy = -((hashHouseId(`${houseId}-${kind}-fy`) % 90) + 30);
    return (
      <div data-testid="city-celebration" className="burst-celebration" aria-hidden="true">
        {FIREWORK_PARTICLES.map((i) => {
          const ang = (i / FIREWORK_PARTICLES.length) * Math.PI * 2;
          const dist = 26 + (i % 3) * 10;
          return (
            <span
              key={i}
              className="firework-particle"
              style={
                {
                  "--fx": `${Math.cos(ang) * dist + dx}px`,
                  "--fy": `${Math.sin(ang) * dist * 0.9 + dy}px`,
                  "--pc": ["#e8c66b", "#5ecfb8", "#7c6cf0"][i % 3],
                } as CSSProperties
              }
            />
          );
        })}
      </div>
    );
  }
  if (kind === "failed") {
    return (
      <div data-testid="city-celebration" className="burst-celebration" aria-hidden="true">
        {FAILURE_FLICKERS.map((i) => (
          <span key={i} className="failure-flicker" style={{ "--fc": "#e36a6a" } as CSSProperties} />
        ))}
      </div>
    );
  }
  // aborted: brief dim pulse bars.
  return (
    <div data-testid="city-celebration" className="burst-celebration" aria-hidden="true">
      <span className="aborted-bar" style={{ "--fc": "#8b93b8" } as CSSProperties} />
      <span className="aborted-bar" style={{ "--fc": "#8b93b8" } as CSSProperties} />
    </div>
  );
}
