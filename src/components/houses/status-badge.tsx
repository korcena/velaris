"use client";

import { cn } from "@/lib/utils";
import type { HouseStatus } from "@/shared/types";

const STATUS_STYLES: Record<HouseStatus, { label: string; className: string }> = {
  active: {
    label: "Active",
    className:
      "border-velaris-gold/50 bg-velaris-gold/10 text-velaris-gold status-glow-active",
  },
  disabled: {
    label: "Disabled",
    className: "border-border bg-card/40 text-muted-foreground status-glow-disabled",
  },
  archived: {
    label: "Archived",
    className: "border-border bg-card/30 text-muted-foreground status-glow-archived",
  },
};

export function StatusBadge({ status, className }: { status: HouseStatus; className?: string }) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        s.className,
        className,
      )}
    >
      {status === "active" && <span className="h-1.5 w-1.5 rounded-full bg-velaris-gold" />}
      <span>{s.label}</span>
    </span>
  );
}
