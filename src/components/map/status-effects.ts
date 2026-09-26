/**
 * Pure runtime-status → map-effect mapping — React-free & unit-testable.
 *
 * The redesign maps the app's six derived runtime statuses plus dimmed/inactive
 * onto the reference's four "magic" effects, with two additions:
 *
 *  - `planning` is a DISTINCT effect key (a calm moonlit rune ring, never
 *    collapsed to `working`), so "busy planning" vs "busy executing" is legible.
 *  - `paused` is a distinct key rendered as a desaturated idle (Stage C).
 *
 * Failures come in two flavours (spec §4):
 *  - STICKY: a High Lord whose `planState === "aborted"` stays failed while the
 *    persisted signal is aborted.
 *  - TRANSIENT: a realtime `task_failed` / `session_aborted` frame flashes a
 *    fail effect that settles back to the derived status. `transientFailEffect`
 *    resolves this purely (given a base effect, frame kind and elapsed time);
 *    the React shell only owns the timer, not the mapping.
 *
 * NOTE: `animation-map.ts` (celebrations + guards) is intentionally kept
 * unchanged; this module is additive and does not duplicate its logic. The
 * `CelebrationKind` type is imported so both modules agree on frame kinds.
 */

import type {
  HouseStatus,
  HouseRuntimeStatus,
  HouseKind,
  HighLordPlanState,
} from "@/shared/types";
import type { CelebrationKind } from "./animation-map";

/** The map effect keys — one per reference effect plus planning/paused/dimmed. */
export type MapEffect = "idle" | "planning" | "working" | "need" | "paused" | "fail" | "dimmed";

/** Every effect key, in render/legend priority order. */
export const EFFECT_KEYS: readonly MapEffect[] = [
  "idle",
  "planning",
  "working",
  "need",
  "paused",
  "fail",
  "dimmed",
] as const;

/** Human labels for effects (legend, drawer status pill). */
export const EFFECT_LABELS: Record<MapEffect, string> = {
  idle: "Idle",
  planning: "Planning",
  working: "Working",
  need: "Needs you",
  paused: "Paused",
  fail: "Failed",
  dimmed: "Dimmed",
};

/** Effects shown in the legend filter (dimmed excluded — plan Q9). */
export const LEGEND_EFFECTS: readonly MapEffect[] = [
  "idle",
  "planning",
  "working",
  "need",
  "paused",
  "fail",
] as const;

/**
 * How long a transient fail flash lasts (ms). Matches the React shell's
 * transient-fail timers; kept here so the pure resolver is testable.
 */
export const TRANSIENT_FAIL_MS = 2400;

/** Input to `effectForHouse`. Mirrors the fields the map already has to hand. */
export interface EffectInput {
  status: HouseStatus;
  runtimeStatus: HouseRuntimeStatus;
  kind?: HouseKind;
  planState?: HighLordPlanState;
  /** A realtime fail/abort frame is currently flashing for this house. */
  transientFail?: boolean;
}

/**
 * Map a derived runtime status straight to an effect key (no fail/dimmed
 * overrides). `awaiting_approval` and `awaiting_input` both read as `need`.
 */
export function effectForRuntime(runtimeStatus: HouseRuntimeStatus): MapEffect {
  switch (runtimeStatus) {
    case "idle":
      return "idle";
    case "planning":
      return "planning";
    case "working":
      return "working";
    case "awaiting_approval":
    case "awaiting_input":
      return "need";
    case "paused":
      return "paused";
  }
}

/**
 * The full effect for a house. Precedence (spec §4):
 * disabled|archived → dimmed (wins) → transient fail → sticky fail → runtime.
 */
export function effectForHouse(input: EffectInput): MapEffect {
  if (input.status === "disabled" || input.status === "archived") return "dimmed";
  if (input.transientFail) return "fail";
  if (isStickyFail(input)) return "fail";
  return effectForRuntime(input.runtimeStatus);
}

/** A realtime frame kind that should flash a transient fail. */
export function isTransientFail(kind: CelebrationKind): boolean {
  return kind === "failed" || kind === "aborted";
}

/**
 * A High Lord with an aborted plan is persistently failed. Non-High-Lord
 * houses never get sticky fail from `planState`.
 */
export function isStickyFail(h: { kind?: HouseKind; planState?: HighLordPlanState }): boolean {
  return h.kind === "high_lord" && h.planState === "aborted";
}

/**
 * Resolve the transient-fail overlay purely: return `fail` while a fail/abort
 * frame is within the transient window, otherwise the base effect unchanged.
 * `elapsedMs` is time since the frame arrived.
 */
export function transientFailEffect(
  base: MapEffect,
  kind: CelebrationKind,
  elapsedMs: number,
  windowMs = TRANSIENT_FAIL_MS,
): MapEffect {
  if (!isTransientFail(kind)) return base;
  return elapsedMs < windowMs ? "fail" : base;
}

/** Count houses per effect (for the cartouche summary + legend counts). */
export function countEffects(houses: EffectInput[]): Record<MapEffect, number> {
  const counts: Record<MapEffect, number> = {
    idle: 0,
    planning: 0,
    working: 0,
    need: 0,
    paused: 0,
    fail: 0,
    dimmed: 0,
  };
  for (const h of houses) counts[effectForHouse(h)] += 1;
  return counts;
}

/**
 * Whether a house with `effect` should be dimmed by the legend filter.
 * `filter === null` means "show everything"; `dimmed` houses stay faded even
 * when a filter is active, matching the reference's `dimmed` class semantics.
 */
export function isDimmedByFilter(effect: MapEffect, filter: MapEffect | null): boolean {
  return filter !== null && effect !== filter;
}
