"use client";

/**
 * Court abort visual (Phase 4 addendum D4e(a)) — a CSS burning-castle strip
 * shown on the plan board header when the parent task aborted.
 *
 * Pure CSS; animation = opacity + transform only; a reduced-motion static
 * variant (dimmed crimson banner with the abort copy, no keyframes).
 */

import type { CSSProperties } from "react";
import { useVelarisReducedMotion } from "@/components/map/reduced-motion";

const SMOKE_PLUMES = [0, 1, 2];
const EMBER_SPANS = [0, 1, 2, 3, 4];
const FLAME_TRIANGLES = [0, 1, 2];

export const ABORT_REASON_COPY: Record<string, string> = {
  retries_exhausted: "The High Lord's plan collapsed — a subtask failed 3 times",
  token_budget_exceeded: "The High Lord's plan collapsed — the treasury ran dry",
  user_cancel: "The High Lord's plan collapsed — recalled by decree",
};

export function formatAbortReason(reason: string | undefined | null): string {
  return ABORT_REASON_COPY[reason ?? ""] ?? "The High Lord's plan collapsed";
}

export function AbortVisual({ reason }: { reason: string | undefined | null }) {
  const reducedMotion = useVelarisReducedMotion();

  if (reducedMotion) {
    return (
      <div
        data-testid="court-abort-static"
        className="court-abort court-abort-static"
        role="status"
        aria-label={`Plan aborted: ${formatAbortReason(reason)}`}
      >
        <span className="court-abort-flame-static" aria-hidden="true" />
        <p className="court-abort-copy">Plan aborted — {formatAbortReason(reason)}</p>
      </div>
    );
  }

  return (
    <div
      data-testid="court-abort"
      className="court-abort"
      role="status"
      aria-label={`Plan aborted: ${formatAbortReason(reason)}`}
    >
      <div className="court-abort-burning" aria-hidden="true">
        {/* Layered flame triangles over a burning keep silhouette */}
        <div className="court-abort-keep" aria-hidden="true" />
        {FLAME_TRIANGLES.map((i) => (
          <span
            key={`f${i}`}
            className="court-abort-flame"
            style={{ "--flame-i": i } as CSSProperties}
          />
        ))}
        {EMBER_SPANS.map((i) => (
          <span key={`e${i}`} className="court-abort-ember" style={{ "--ember-i": i } as CSSProperties} />
        ))}
        {/* Smoke plumes rising above */}
        {SMOKE_PLUMES.map((i) => (
          <span key={`s${i}`} className="court-abort-smoke" style={{ "--smoke-i": i } as CSSProperties} />
        ))}
      </div>
      <p className="court-abort-copy">Plan aborted — {formatAbortReason(reason)}</p>
    </div>
  );
}
