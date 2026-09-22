"use client";

/**
 * Activity timeline (Phase 3) — presentational. Renders described activity
 * items from ExecutionEventDtos (already described via describeExecutionEvent).
 * No data fetching — the parent fetches events and passes them in.
 */

import { useEffect, useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ExecutionEventDto } from "@/shared/types";
import { describeExecutionEvent, type ActivityItem } from "./describe-event";

const TONE_CLASS: Record<ActivityItem["tone"], string> = {
  default: "border-border bg-card/30 text-foreground",
  gold: "border-velaris-gold/50 bg-velaris-gold/5 text-velaris-gold",
  crimson: "border-velaris-crimson/50 bg-velaris-crimson/5 text-velaris-crimson",
  muted: "border-border bg-card/20 text-muted-foreground",
};

const KIND_LABEL: Record<ActivityItem["kind"], string> = {
  quest: "Quest",
  text: "Message",
  tool: "Tool",
  approval: "Approval",
  system: "System",
  error: "Error",
};

export function ActivityTimeline({ events }: { events: ExecutionEventDto[] }) {
  const items = useMemo(
    () =>
      events
        .map((ev) => ({ ev, item: describeExecutionEvent(ev) }))
        .filter((x): x is { ev: ExecutionEventDto; item: ActivityItem } => x.item !== null),
    [events],
  );

  useEffect(() => {
    // Scroll the newest activity into view on mount / updates.
    const el = document.getElementById("activity-timeline-scroll");
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  if (items.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No activity yet for this quest.
      </p>
    );
  }

  return (
    <ScrollArea id="activity-timeline-scroll" className="h-[24rem]">
      <ol className="space-y-2 px-1">
        {items.map(({ ev, item }) => (
          <li
            key={ev.id}
            className={cn(
              "rounded-lg border px-3 py-2",
              TONE_CLASS[item.tone],
              (item.tone === "gold" || item.tone === "crimson") && "border-l-4",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="outline" className="shrink-0">
                  {KIND_LABEL[item.kind]}
                </Badge>
                <span className="truncate text-sm font-medium">{item.label}</span>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {new Date(ev.createdAt).toLocaleString()}
              </span>
            </div>

            {item.text ? (
              <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                {item.text}
              </p>
            ) : null}
            {item.mono ? (
              <p className="mt-2 overflow-x-auto rounded bg-black/30 px-2 py-1 font-mono text-xs text-foreground/80">
                {item.mono}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </ScrollArea>
  );
}
