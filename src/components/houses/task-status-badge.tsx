"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { TaskStatus } from "@/shared/types";

/** Terminal statuses — tasks in these cannot be cancelled (Job F.2). */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

const TASK_STATUS_STYLES: Record<TaskStatus, { label: string; className: string }> = {
  queued: {
    label: "queued",
    className: "bg-muted text-muted-foreground",
  },
  running: {
    label: "running",
    className: "bg-velaris-teal/15 text-velaris-teal",
  },
  awaiting_approval: {
    label: "awaiting approval",
    className: "bg-velaris-gold/15 text-velaris-gold",
  },
  awaiting_input: {
    label: "awaiting input",
    className: "bg-velaris-crimson/15 text-velaris-crimson",
  },
  completed: {
    label: "completed",
    className: "bg-velaris-purple/15 text-velaris-purple",
  },
  failed: {
    label: "failed",
    className: "bg-velaris-crimson/20 text-velaris-crimson",
  },
  cancelled: {
    label: "cancelled",
    className: "bg-secondary text-secondary-foreground",
  },
  interrupted: {
    label: "interrupted",
    className: "bg-velaris-silver-muted/15 text-muted-foreground",
  },
};

/** Full task-status badge with the Phase 2 palette (Job F.1). */
export function TaskStatusBadge({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  const s = TASK_STATUS_STYLES[status] ?? {
    label: status,
    className: "bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={cn(s.className, className)}>
      {s.label}
    </Badge>
  );
}
