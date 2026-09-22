"use client";

/**
 * House building (Phase 3) — a single silhouetted SVG building for the city.
 * Renders one <g> per house with a pointed roof (3 variants), windows, chimney
 * and door. Status visuals (planning pulse, working smoke, awaiting bird, etc.)
 * are driven by CSS `[data-state]` selectors in globals.css.
 *
 * Clickable → /houses/{id}; keyboard accessible (tabindex + Enter).
 */

import { useRouter } from "next/navigation";
import { statusToVisualState, type CelebrationKind } from "@/components/city/animation-map";
import { hashHouseId } from "@/components/city/layout";
import type { CityPlot } from "@/components/city/layout";
import type { HouseCardData } from "@/components/houses/house-card";

const TINT_FILLS = ["#e8c66b", "#5ecfb8", "#7c6cf0"];
const SMOKE_PUFFS = [0, 1, 2];

function variantFor(plot: CityPlot): { roof: number; tint: number } {
  return { roof: plot.roofVariant, tint: plot.tintVariant };
}

export function HouseBuilding({
  plot,
  house,
  celebration,
  reducedMotion,
}: {
  plot: CityPlot;
  house: HouseCardData;
  celebration: CelebrationKind | null;
  reducedMotion: boolean;
}) {
  const router = useRouter();
  const state = statusToVisualState(house);
  const { tint } = variantFor(plot);
  const tintFill = TINT_FILLS[tint] ?? TINT_FILLS[0];

  // Map plot percentages (0..100) into the skyline viewBox (1000 x 420).
  const VB_W = 1000;
  const VB_H = 420;
  const centerX = (plot.x / 100) * VB_W;
  const groundY = (plot.y / 100) * VB_H;

  // Deterministic CSS variables for the celebration burst (from house+task ids)
  // — stable per trigger so the animation is reproducible.
  const burstVars =
    celebration && !reducedMotion
      ? {
          "--fx": `${(hashHouseId(`${house.id}-${celebration}-fx`) % 60) - 30}px`,
          "--fy": `${-((hashHouseId(`${house.id}-${celebration}-fy`) % 90) + 30)}px`,
        }
      : undefined;

  const baseHeight = 90; // default facade height in viewBox units
  const height = baseHeight * plot.heightVariance;
  const width = 46;

  function go() {
    router.push(`/houses/${house.id}`);
  }

  return (
    <g
      transform={`translate(${centerX} ${groundY})`}
      data-state={state}
      data-testid={`city-building-${house.id}`}
      role="img"
      aria-label={house.name}
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      }}
      className="city-building cursor-pointer outline-none focus-visible:stroke-velaris-gold"
      style={burstVars as React.CSSProperties}
    >
      {/* === Building body (draws upward from baseline at y=0) === */}
      <g>
        {/* Facade */}
        <rect x={-width / 2} y={-height} width={width} height={height} rx={2} className="building-facade" />
        {/* Roof */}
        <Roof roofVariant={plot.roofVariant} width={width} height={height} />
        {/* Door */}
        <rect x={-6} y={-18} width={12} height={18} rx={2} className="building-door" />
        {/* Windows — warm gold fill, tint shifted */}
        <Windows x={-width / 2} width={width} top={-height + 16} height={height} tintFill={tintFill} />
        {/* Chimney (always present; smoke appears when working) */}
        <rect x={-width / 2 + 8} y={-height - 12} width={8} height={12} className="building-chimney" />
      </g>

      {/* Smoke puffs shown when data-state=working (driven by CSS). */}
      {state === "working" &&
        SMOKE_PUFFS.map((i) => (
          <g key={i} className="smoke-puff" style={{ ["--puff-i" as string]: i }}>
            <circle cx={-width / 2 + 12} cy={-height - 16} r={4} className="smoke-puff-circle" />
          </g>
        ))}

      {/* Messenger bird silhouette when awaiting approval / input. */}
      {(state === "awaiting_approval" || state === "awaiting_input") && (
        <g className="messenger-bird" transform={`translate(0, ${-height - 26})`}>
          <path d="M-7 0 C -4 -6, 4 -6, 7 0 C 4 2, -4 2, -7 0 Z" className="bird-body" />
          <path d="M-7 0 L -12 -4 L -9 1 Z" className="bird-wing-left" />
          <path d="M7 0 L 12 -4 L 9 1 Z" className="bird-wing-right" />
        </g>
      )}

      {/* Pending-approval gold bird dot above the roof even while idle/working. */}
      {(house.pendingApprovals ?? 0) > 0 && (
        <circle data-testid={`city-bird-dot-${house.id}`} cx={width / 2 - 8} cy={-height - 6} r={2.5} className="bird-dot" />
      )}

      {/* Celebration overlay */}
      {celebration
        ? reducedMotion
          ? <StaticCelebration kind={celebration} />
          : <BurstCelebration kind={celebration} />
        : null}

      {/* House name label under the building baseline */}
      <text x={0} y={26} textAnchor="middle" className="fill-velaris-silver-muted text-[13px]">
        {house.name}
      </text>
    </g>
  );
}

function Roof({ roofVariant, width, height }: { roofVariant: number; width: number; height: number }) {
  const half = width / 2;
  const tip = -height - 14;
  switch (roofVariant) {
    case 0: // steep pointed
      return <polygon points={`${-half},${-height} 0,${tip} ${half},${-height}`} className="building-roof" />;
    case 1: // mansard-ish with a peak notch
      return (
        <g className="building-roof">
          <polygon points={`${-half},${-height} ${-half + 10},${tip + 6} ${-half + 14},${-height}`} />
          <polygon points={`${-half + 14},${-height} ${half - 14},${-height} ${half - 10},${tip + 6}`} />
          <polygon points={`${half - 14},${-height} ${half},${-height} ${half - 10},${tip + 6}`} />
        </g>
      );
    case 2: // onion/bulb
      return <path d={`M ${-half} ${-height} C ${-half - 4} ${tip + 4}, 0 ${tip}, 0 ${-height - 22} C 0 ${tip}, ${half + 4} ${tip + 4}, ${half} ${-height} Z`} className="building-roof" />;
    default:
      return null;
  }
}

function Windows({
  x,
  width,
  top,
  height,
  tintFill,
}: {
  x: number;
  width: number;
  top: number;
  height: number;
  tintFill: string;
}) {
  const cols = 3;
  const colWidth = width / cols;
  const colsArr = [0, 1, 2];
  const rows = 2;
  // Windows placed top→down, leaving room for the door at the bottom.
  const winW = colWidth * 0.5;
  const winH = 8;
  return (
    <g className="building-windows" fill={tintFill}>
      {colsArr.flatMap((c, ri) =>
        Array.from({ length: rows }, (_, ri_) => {
          const cy = top + ri_ * (height / 4) + winH / 2;
          const cx = x + c * colWidth + colWidth / 2;
          return <rect key={`${c}-${ri_}-${ri}`} x={cx - winW / 2} y={cy} width={winW} height={winH} rx={1} />;
        }),
      )}
    </g>
  );
}

function StaticCelebration({ kind }: { kind: CelebrationKind }) {
  if (kind === "completed") {
    return (
      <g data-testid="city-static-celebration" className="fill-velaris-gold" transform="translate(0, -140)">
        <path d="M0 -14 L 4 -4 L 14 -4 L 6 2 L 9 13 L 0 7 L -9 13 L -6 2 L -14 -4 L -4 -4 Z" />
      </g>
    );
  }
  if (kind === "failed") {
    return (
      <g data-testid="city-static-celebration" className="fill-velaris-crimson" transform="translate(0, -140)">
        <path d="M-10 -10 L -4 -4 M -4 -10 L -10 -4" />
        <path d="M10 -10 L 4 -4 M 4 -10 L 10 -4" />
      </g>
    );
  }
  // aborted → brief gray pause bars
  return (
    <g data-testid="city-static-celebration" transform="translate(0, -140)">
      <rect x={-6} y={-8} width={4} height={16} className="fill-velaris-silver-muted" />
      <rect x={2} y={-8} width={4} height={16} className="fill-velaris-silver-muted" />
    </g>
  );
}

function BurstCelebration({ kind }: { kind: CelebrationKind }) {
  if (kind === "completed") {
    const particles = Array.from({ length: 12 }, (_, i) => i);
    return (
      <g data-testid="city-celebration" transform="translate(0, -130)">
        {particles.map((i) => {
          const ang = (i / 12) * Math.PI * 2;
          const dist = 26 + (i % 3) * 10;
          return (
            <circle
              key={i}
              r={3}
              className="firework-particle"
              cx={Math.cos(ang) * dist}
              cy={Math.sin(ang) * dist * 0.9}
              fill={["#e8c66b", "#5ecfb8", "#7c6cf0"][i % 3]}
            />
          );
        })}
      </g>
    );
  }
  if (kind === "failed") {
    const flickers = Array.from({ length: 6 }, (_, i) => i);
    return (
      <g data-testid="city-celebration" transform="translate(0, -126)">
        {flickers.map((i) => (
          <rect
            key={i}
            x={-14 + i * 5}
            y={-3}
            width={2.5}
            height={9}
            className="failure-flicker"
            fill="#e36a6a"
          />
        ))}
      </g>
    );
  }
  // aborted: brief dim pulse (rendered by CSS on the wrapper).
  return (
    <g data-testid="city-celebration" transform="translate(0, -130)">
      <rect x={-8} y={-9} width={5} height={18} className="aborted-bar" fill="#8b93b8" />
      <rect x={2} y={-9} width={5} height={18} className="aborted-bar" fill="#8b93b8" />
    </g>
  );
}
