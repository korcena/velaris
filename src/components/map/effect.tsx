"use client";

/**
 * Effect renderer for the top-down archipelago map — React/CSS port of the
 * design reference's `FX` functions + `buildFx` (velaris-map.html:677-767).
 *
 * Each `MapEffect` is split into an `EffectUnder` layer (behind the citadel
 * glyph) and an `EffectOver` layer (in front), exactly as the reference's
 * `buildFx` does, so the house art always sits between them. `EffectDefs`
 * renders the static radial gradients ONCE at the map root; every other
 * component references those ids (they resolve document-wide).
 *
 * Determinism: the reference uses `Math.random()` for spark/ember angles,
 * durations and negatives delays. This port derives all of them from the
 * seeded `random.ts` helpers (`seededRng`, `fxDelay`) so SSR and hydration
 * output match — never `Math.random()` in render.
 *
 * Performance (plan §6): all animation is transform/opacity only; animated
 * nodes carry their position on a parent `<g>`; no `feGaussianBlur` filters
 * are used (static translucent discs / radial-gradient auras replace them).
 */

import type { CSSProperties, ReactNode } from "react";
import { EFFECT_COLORS, MAP_PALETTE } from "./palette";
import { fxDelay, hashHouseId, seededRng } from "./random";
import { IslandGlyph } from "./island-glyph";
import type { MapEffect } from "./status-effects";
import type { CelebrationKind } from "./animation-map";

/** The gradient ids registered by `EffectDefs`. */
export const EFFECT_GRADIENT_IDS = {
  idle: "map-aura-idle",
  planning: "map-aura-planning",
  working: "map-aura-working",
  need: "map-aura-need",
  fail: "map-aura-fail",
  sweep: "map-sweep-need",
  sweepMini: "map-sweep-need-mini",
} as const;

/** Radial gradients referenced by the effects. Render exactly once. */
export function EffectDefs() {
  return (
    <defs>
      <radialGradient id="map-ocean-grad" cx="50%" cy="45%" r="75%">
        <stop offset="0" stopColor="#1d285c" />
        <stop offset="0.6" stopColor="#141b44" />
        <stop offset="1" stopColor="#0a0d28" />
      </radialGradient>
      <radialGradient id="map-land-grad" cx="50%" cy="45%" r="60%">
        <stop offset="0" stopColor="#2f3663" />
        <stop offset="1" stopColor="#232849" />
      </radialGradient>
      <radialGradient id={EFFECT_GRADIENT_IDS.idle}>
        <stop offset="0" stopColor={MAP_PALETTE.idle} stopOpacity={0.45} />
        <stop offset="1" stopColor={MAP_PALETTE.idle} stopOpacity={0} />
      </radialGradient>
      <radialGradient id={EFFECT_GRADIENT_IDS.planning}>
        <stop offset="0" stopColor={MAP_PALETTE.paused} stopOpacity={0.4} />
        <stop offset="1" stopColor={MAP_PALETTE.paused} stopOpacity={0} />
      </radialGradient>
      <radialGradient id={EFFECT_GRADIENT_IDS.working}>
        <stop offset="0" stopColor={MAP_PALETTE.work} stopOpacity={0.6} />
        <stop offset="1" stopColor={MAP_PALETTE.work} stopOpacity={0} />
      </radialGradient>
      <radialGradient id={EFFECT_GRADIENT_IDS.need}>
        <stop offset="0" stopColor={MAP_PALETTE.need} stopOpacity={0.7} />
        <stop offset="1" stopColor={MAP_PALETTE.need} stopOpacity={0} />
      </radialGradient>
      <radialGradient id={EFFECT_GRADIENT_IDS.fail}>
        <stop offset="0" stopColor={MAP_PALETTE.fail} stopOpacity={0.55} />
        <stop offset="1" stopColor={MAP_PALETTE.fail} stopOpacity={0} />
      </radialGradient>
      <radialGradient
        id={EFFECT_GRADIENT_IDS.sweep}
        gradientUnits="userSpaceOnUse"
        cx={0}
        cy={0}
        r={150}
      >
        <stop offset="0" stopColor={MAP_PALETTE.need} stopOpacity={0.55} />
        <stop offset="0.55" stopColor={MAP_PALETTE.need} stopOpacity={0.16} />
        <stop offset="1" stopColor={MAP_PALETTE.need} stopOpacity={0} />
      </radialGradient>
      <radialGradient
        id={EFFECT_GRADIENT_IDS.sweepMini}
        gradientUnits="userSpaceOnUse"
        cx={0}
        cy={0}
        r={40}
      >
        <stop offset="0" stopColor={MAP_PALETTE.need} stopOpacity={0.7} />
        <stop offset="1" stopColor={MAP_PALETTE.need} stopOpacity={0} />
      </radialGradient>
    </defs>
  );
}

/** An invisible centre disc + CSS rotation, mirroring the reference `spinGroup`. */
function SpinGroup({
  r,
  dur,
  rev,
  seed,
  children,
}: {
  r: number;
  dur: number;
  rev?: boolean;
  /** Deterministic negative delay so identical rings drift out of sync. */
  seed?: number;
  children: ReactNode;
}) {
  return (
    <g
      className={`fx-spin${rev ? " rev" : ""}`}
      style={
        {
          "--dur": `${dur}s`,
          ...(seed !== undefined ? { animationDelay: fxDelay(seed, dur) } : {}),
        } as CSSProperties
      }
    >
      {/* Keeps the rotation centred on the house (reference comment). */}
      <circle r={r} fill="none" stroke="none" />
      {children}
    </g>
  );
}

const IDLE = EFFECT_COLORS.idle;
const WORK = EFFECT_COLORS.working;
const NEED = EFFECT_COLORS.need;
const FAIL = EFFECT_COLORS.fail;
const PLANNING = EFFECT_COLORS.planning;

/** The `idle` under-layer: slow breathing aura + dotted ward ring. */
function IdleUnder({ seed }: { seed: number }) {
  return (
    <>
      <circle
        r={34}
        fill={`url(#${EFFECT_GRADIENT_IDS.idle})`}
        className="fx-breathe"
        style={{ "--dur": "6s", animationDelay: fxDelay(seed, 6) } as CSSProperties}
      />
      <SpinGroup r={23} dur={60} seed={seed}>
        <circle
          r={23}
          fill="none"
          stroke={IDLE}
          strokeWidth={1}
          opacity={0.4}
          strokeDasharray="1 5"
        />
      </SpinGroup>
    </>
  );
}

function IdleOver({ seed }: { seed: number }) {
  return (
    <SpinGroup r={19} dur={14} seed={seed}>
      <circle cx={19} r={1.6} fill={IDLE} opacity={0.85} />
    </SpinGroup>
  );
}

/**
 * The DISTINCT `planning` variant (spec §4): a calm, moonlit rune ring — two
 * slow counter-rotating dashed rings and one drifting mote. Deliberately
 * low-contrast and gold-free so it never reads as `working`.
 */
function PlanningUnder({ seed }: { seed: number }) {
  return (
    <>
      <circle
        r={34}
        fill={`url(#${EFFECT_GRADIENT_IDS.planning})`}
        className="fx-breathe"
        style={{ "--dur": "7s", animationDelay: fxDelay(seed, 7) } as CSSProperties}
      />
      <SpinGroup r={25} dur={40} seed={seed}>
        <circle
          r={25}
          fill="none"
          stroke={PLANNING}
          strokeWidth={1}
          opacity={0.45}
          strokeDasharray="2 7"
        />
      </SpinGroup>
      <SpinGroup r={18} dur={30} rev seed={seed + 1}>
        <circle
          r={18}
          fill="none"
          stroke={IDLE}
          strokeWidth={0.8}
          opacity={0.3}
          strokeDasharray="1 4"
        />
      </SpinGroup>
    </>
  );
}

function PlanningOver({ seed }: { seed: number }) {
  return (
    <SpinGroup r={17} dur={22} seed={seed}>
      <circle cx={17} r={1.3} fill={IDLE} opacity={0.7} />
    </SpinGroup>
  );
}

/** The `working` under-layer: fast counter-rotating rune rings + gather ring. */
function WorkingUnder({ seed }: { seed: number }) {
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6;
    const outer = i % 3 ? 32 : 35;
    return {
      x1: Number((Math.cos(a) * 30).toFixed(2)),
      y1: Number((Math.sin(a) * 30).toFixed(2)),
      x2: Number((Math.cos(a) * outer).toFixed(2)),
      y2: Number((Math.sin(a) * outer).toFixed(2)),
    };
  });
  return (
    <>
      <circle
        r={40}
        fill={`url(#${EFFECT_GRADIENT_IDS.working})`}
        className="fx-breathe"
        style={{ "--dur": "1.8s", animationDelay: fxDelay(seed, 1.8) } as CSSProperties}
      />
      <SpinGroup r={32} dur={10} seed={seed}>
        <circle
          r={30}
          fill="none"
          stroke={WORK}
          strokeWidth={1.2}
          opacity={0.75}
          strokeDasharray="1.5 4 7 4"
        />
        {ticks.map((t, i) => (
          <line
            key={i}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={WORK}
            strokeWidth={1}
            opacity={0.7}
          />
        ))}
      </SpinGroup>
      <SpinGroup r={23} dur={7} rev seed={seed + 1}>
        <circle
          r={23}
          fill="none"
          stroke={WORK}
          strokeWidth={1}
          opacity={0.55}
          strokeDasharray="10 6"
        />
      </SpinGroup>
      <circle
        r={38}
        fill="none"
        stroke={WORK}
        strokeWidth={1.2}
        className="fx-gather"
        style={{ "--dur": "1.6s", animationDelay: fxDelay(seed + 2, 1.6) } as CSSProperties}
      />
    </>
  );
}

function WorkingOver({ mini, seed }: { mini?: boolean; seed: number }) {
  const motes = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
  const rng = seededRng(seed, "working-emit");
  return (
    <>
      <SpinGroup r={19} dur={2.4} seed={seed}>
        {motes.map((a, i) => (
          <circle
            key={i}
            cx={Number((Math.cos(a) * 19).toFixed(2))}
            cy={Number((Math.sin(a) * 19).toFixed(2))}
            r={2.2}
            fill="#fff4d6"
          />
        ))}
      </SpinGroup>
      {!mini &&
        Array.from({ length: 6 }, (_, i) => {
          const a = rng() * Math.PI * 2;
          const d = 34 + rng() * 18;
          const dur = 1.4 + rng();
          return (
            <circle
              key={i}
              r={1.2}
              fill={WORK}
              className="fx-emit"
              style={
                {
                  "--dur": `${dur.toFixed(2)}s`,
                  "--dx": `${(Math.cos(a) * d).toFixed(1)}px`,
                  "--dy": `${(Math.sin(a) * d).toFixed(1)}px`,
                  animationDelay: fxDelay(seed + i, dur),
                } as CSSProperties
              }
            />
          );
        })}
    </>
  );
}

/** The `need` under-layer: rotating lighthouse sweep + expanding ripples. */
function NeedUnder({ mini, seed }: { mini?: boolean; seed: number }) {
  const rr = mini ? 40 : 150;
  const h = 0.3;
  const wedge = `M0 0 L${(rr * Math.cos(-h)).toFixed(1)} ${(rr * Math.sin(-h)).toFixed(
    1,
  )} A${rr} ${rr} 0 0 1 ${(rr * Math.cos(h)).toFixed(1)} ${(rr * Math.sin(h)).toFixed(1)}Z`;
  return (
    <>
      <SpinGroup r={rr} dur={4} seed={seed}>
        <path
          d={wedge}
          fill={`url(#${mini ? EFFECT_GRADIENT_IDS.sweepMini : EFFECT_GRADIENT_IDS.sweep})`}
        />
      </SpinGroup>
      {Array.from({ length: 3 }, (_, i) => (
        <circle
          key={i}
          r={mini ? 14 : 22}
          fill="none"
          stroke={NEED}
          strokeWidth={1.4}
          className="fx-ripple"
          style={{ "--dur": "2.4s", animationDelay: `${i * 0.8}s` } as CSSProperties}
        />
      ))}
      <circle
        r={40}
        fill={`url(#${EFFECT_GRADIENT_IDS.need})`}
        className="fx-breathe"
        style={{ "--dur": "1.2s", animationDelay: fxDelay(seed, 1.2) } as CSSProperties}
      />
    </>
  );
}

/** The `need` over-layer: a bobbing "!" sigil badge. */
function NeedOver() {
  return (
    <g transform="translate(15 -18)">
      <g className="fx-bob">
        <path
          d="M0 -8.5 L7.5 0 L0 8.5 L-7.5 0Z"
          fill={NEED}
          stroke="#fff"
          strokeWidth={1}
        />
        <text
          y={3.6}
          textAnchor="middle"
          fontFamily="var(--font-sans)"
          fontWeight={700}
          fontSize={10}
          fill="#2a0a24"
        >
          !
        </text>
      </g>
    </g>
  );
}

/** The `fail` under-layer: flickering dim aura + broken ward ring. */
function FailUnder({ seed }: { seed: number }) {
  return (
    <>
      <circle
        r={40}
        fill={`url(#${EFFECT_GRADIENT_IDS.fail})`}
        className="fx-flicker"
        style={{ "--dur": "2.3s", animationDelay: fxDelay(seed, 2.3) } as CSSProperties}
      />
      <circle
        r={21}
        fill="none"
        stroke={FAIL}
        strokeWidth={1}
        opacity={0.45}
        strokeDasharray="5 3 1 6 9 4"
      />
    </>
  );
}

/** The `fail` over-layer: cracked roof, drifting smoke and scattered embers. */
function FailOver({ mini, seed }: { mini?: boolean; seed: number }) {
  const puffs = mini ? 2 : 4;
  const emberCount = mini ? 3 : 7;
  const rng = seededRng(seed, "fail-ember");
  return (
    <>
      <path
        d="M-10 -7 L-4 -2 L-6 2 L1 4 L-1 8 L5 11"
        fill="none"
        stroke={FAIL}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 -10 L6 -5 L10 -4"
        fill="none"
        stroke={FAIL}
        strokeWidth={1}
        strokeLinecap="round"
        opacity={0.8}
      />
      {Array.from({ length: puffs }, (_, i) => (
        <circle
          key={`s${i}`}
          r={6}
          fill={MAP_PALETTE.ash}
          className="fx-smoke"
          style={
            {
              "--dur": "4s",
              "--dx": `${mini ? 14 : 34}px`,
              "--dy": `${mini ? -12 : -28}px`,
              animationDelay: fxDelay(seed + i, 4),
            } as CSSProperties
          }
        />
      ))}
      {Array.from({ length: emberCount }, (_, i) => {
        const a = -Math.PI / 4 + (rng() - 0.5) * 2.2;
        const d = 14 + rng() * 20;
        const dur = 1.8 + rng() * 1.4;
        return (
          <circle
            key={`e${i}`}
            r={1.5}
            fill="#ff9a6b"
            className="fx-emit"
            style={
              {
                "--dur": `${dur.toFixed(2)}s`,
                "--dx": `${(Math.cos(a) * d).toFixed(1)}px`,
                "--dy": `${(Math.sin(a) * d).toFixed(1)}px`,
                animationDelay: fxDelay(seed + i, dur),
              } as CSSProperties
            }
          />
        );
      })}
    </>
  );
}

/** The effects rendered behind the citadel glyph. */
export function EffectUnder({
  effect,
  mini,
  seed,
}: {
  effect: MapEffect;
  mini?: boolean;
  seed: number;
}) {
  switch (effect) {
    case "idle":
      return <IdleUnder seed={seed} />;
    case "planning":
      return <PlanningUnder seed={seed} />;
    case "paused":
      // Idle art, desaturated via `.is-paused` (CSS).
      return (
        <g className="is-paused">
          <IdleUnder seed={seed} />
        </g>
      );
    case "working":
      return <WorkingUnder seed={seed} />;
    case "need":
      return <NeedUnder mini={mini} seed={seed} />;
    case "fail":
      return <FailUnder seed={seed} />;
    case "dimmed":
      return <g />;
  }
}

/** The effects rendered in front of the citadel glyph. */
export function EffectOver({
  effect,
  mini,
  seed,
}: {
  effect: MapEffect;
  mini?: boolean;
  seed: number;
}) {
  switch (effect) {
    case "idle":
      return <IdleOver seed={seed} />;
    case "planning":
      return <PlanningOver seed={seed} />;
    case "paused":
      return (
        <g className="is-paused">
          <IdleOver seed={seed} />
        </g>
      );
    case "working":
      return <WorkingOver mini={mini} seed={seed} />;
    case "need":
      return <NeedOver />;
    case "fail":
      return <FailOver mini={mini} seed={seed} />;
    case "dimmed":
      return <g />;
  }
}

/**
 * Legend mini: under + glyph + over in the reference's 84×84 box. References
 * the shared gradients from `EffectDefs` (rendered once at the map root).
 */
export function EffectMini({ effect }: { effect: MapEffect }) {
  const seed = hashHouseId(`legend-${effect}`);
  return (
    <svg viewBox="-42 -42 84 84" aria-hidden="true" className="map-effect-mini">
      <g transform="scale(.95)">
        <EffectUnder effect={effect} mini seed={seed} />
        <IslandGlyph effect={effect} sizeVariance={1} highLord={false} seed={seed} />
        <EffectOver effect={effect} mini seed={seed} />
      </g>
    </svg>
  );
}

const FIREWORK_PARTICLES = Array.from({ length: 12 }, (_, i) => i);
const FAILURE_FLICKERS = Array.from({ length: 6 }, (_, i) => i);
const BURN_FLAMES = [0, 1, 2];
const BURN_SMOKE = [0, 1, 2];

/** Reduced-motion static glyph (gold star / crimson x / gray bars). */
export function StaticCelebration({ kind }: { kind: CelebrationKind }) {
  return (
    <div data-testid="city-static-celebration" className="static-celebration" role="img" aria-hidden="true">
      {kind === "completed" && <span className="static-glyph static-glyph-star">✦</span>}
      {kind === "failed" && <span className="static-glyph static-glyph-x">✕</span>}
      {kind === "aborted" && <span className="static-glyph static-glyph-bars">❚❚</span>}
    </div>
  );
}

/** Animated burst (firework particles / flickers / aborted bars). */
export function BurstCelebration({ kind, houseId }: { kind: CelebrationKind; houseId: string }) {
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

/** Celebration overlay, reduced-motion aware. */
export function CelebrationOverlay({
  kind,
  reducedMotion,
  houseId,
}: {
  kind: CelebrationKind;
  reducedMotion: boolean;
  houseId: string;
}) {
  return reducedMotion ? (
    <StaticCelebration kind={kind} />
  ) : (
    <BurstCelebration kind={kind} houseId={houseId} />
  );
}

/**
 * Burning-castle overlay while the High Lord's latest plan is aborted (D4e(b)).
 * Preserves the `map-castle-burning` / `map-castle-burning-static` testids and
 * reuses the existing `.castle-burning*` CSS. transform/opacity only.
 */
export function BurningOverlay({
  reducedMotion,
  houseId,
}: {
  reducedMotion: boolean;
  houseId: string;
}) {
  const seed = hashHouseId(`${houseId}-abort`);
  if (reducedMotion) {
    return (
      <div
        data-testid="map-castle-burning-static"
        className="castle-burning castle-burning-static"
        aria-hidden="true"
      />
    );
  }
  return (
    <div data-testid="map-castle-burning" className="castle-burning" aria-hidden="true">
      {BURN_SMOKE.map((i) => (
        <span
          key={`bs${i}`}
          className="castle-burning-smoke"
          style={{ "--burn-smoke": ((seed + i) % 3) as number } as CSSProperties}
        />
      ))}
      {BURN_FLAMES.map((i) => (
        <span
          key={`bf${i}`}
          className="castle-burning-flame"
          style={{ "--burn-flame": ((seed + i) % 3) as number } as CSSProperties}
        />
      ))}
    </div>
  );
}
