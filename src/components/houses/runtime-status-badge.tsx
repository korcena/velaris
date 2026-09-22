"use client";

/**
 * Runtime status badge for houses (Phase 2) — reflects the derived execution
 * status (idle/planning/working/awaiting_approval/awaiting_input), following
 * the existing StatusBadge conventions. Purely presentational.
 */

import { cn } from "@/lib/utils";
import type { HouseRuntimeStatus, HouseStatus } from "@/shared/types";

const RUNTIME_STYLES: Record<HouseRuntimeStatus, { label: string; className: string; dot: string }> = {
  idle: {
    label: "Idle",
    className: "border-border bg-card/40 text-muted-foreground",
    dot: "bg-velaris-silver-muted",
  },
  planning: {
    label: "Planning",
    className: "border-velaris-purple/40 bg-velaris-purple/10 text-velaris-purple",
    dot: "bg-velaris-purple",
  },
  working: {
    label: "Working",
    className: "border-velaris-teal/40 bg-velaris-teal/10 text-velaris-teal",
    dot: "bg-velaris-teal",
  },
  awaiting_approval: {
    label: "Awaiting approval",
    className: "border-velaris-gold/50 bg-velaris-gold/10 text-velaris-gold status-glow-active",
    dot: "bg-velaris-gold",
  },
  awaiting_input: {
    label: "Awaiting input",
    className: "border-velaris-crimson/40 bg-velaris-crimson/10 text-velaris-crimson",
    dot: "bg-velaris-crimson",
  },
};

export function RuntimeStatusBadge({
  runtimeStatus,
  className,
}: {
  runtimeStatus: HouseRuntimeStatus;
  className?: string;
}) {
  const s = RUNTIME_STYLES[runtimeStatus];
  if (!s) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        s.className,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      <span>{s.label}</span>
    </span>
  );
}

/** Maps a stored house status to its runtime-ish label for the fallback case. */
export const HOUSE_STATUS_LABELS: Record<HouseStatus, string> = {
  active: "Active",
  disabled: "Disabled",
  archived: "Archived",
};
