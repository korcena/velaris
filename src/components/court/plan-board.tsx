"use client";

/**
 * Court plan board (Phase 4 §7.2 + addendum D2d/D4e) — a layered DAG of the
 * High Lord's subtasks grouped by dependency depth. Parallel siblings share a
 * row. Shows plan-id chips, destination house names, status badges, attempt
 * counts, dependency chips, a cost rollup, and a consolidated summary +
 * DiffViewer when the parent is terminal. When the plan aborted (parent
 * failed with execution_preferences.plan.abortReason) a burning-castle strip
 * (AbortVisual) tops the board.
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TaskStatusBadge } from "@/components/houses/task-status-badge";
import { DiffViewer } from "@/components/houses/results/diff-viewer";
import { AbortVisual } from "./abort-visual";
import { computePlanDepth } from "./plan-depth";
import { apiFetch } from "@/lib/api-client";
import type { PlanDto, SubtaskDto, SubtaskStatus } from "@/shared/types";

const SUBTASK_STYLES: Record<SubtaskStatus, { label: string; className: string }> = {
  planned: { label: "planned", className: "bg-muted text-muted-foreground" },
  ready: { label: "ready", className: "bg-velaris-teal/15 text-velaris-teal" },
  delegated: { label: "delegated", className: "bg-velaris-purple/15 text-velaris-purple" },
  in_flight: { label: "in flight", className: "bg-velaris-teal/20 text-velaris-teal" },
  completed: { label: "completed", className: "bg-velaris-purple/20 text-velaris-purple" },
  failed: { label: "failed", className: "bg-velaris-crimson/20 text-velaris-crimson" },
  cancelled: { label: "cancelled", className: "bg-secondary text-secondary-foreground" },
};

function SubtaskStatusBadge({ status }: { status: SubtaskStatus }) {
  const s = SUBTASK_STYLES[status];
  return <Badge variant="outline" className={s?.className}>{s?.label ?? status}</Badge>;
}

export function PlanBoard({ parentTaskId, refreshKey }: { parentTaskId: string | null; refreshKey: number }) {
  const [plan, setPlan] = useState<PlanDto | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!parentTaskId) {
      setPlan(null);
      return;
    }
    let alive = true;
    setLoading(true);
    apiFetch<{ plan: PlanDto | null }>(`/api/tasks/${parentTaskId}/plan`)
      .then((res) => {
        if (alive) setPlan(res.plan);
      })
      .catch(() => {
        if (alive) setPlan(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [parentTaskId, refreshKey]);

  if (!parentTaskId) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <p className="font-serif-display text-xl text-foreground">No plan yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Instruct the High Lord above to draft a plan of subtasks.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (loading && !plan) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Drafting the plan…
        </CardContent>
      </Card>
    );
  }

  if (!plan) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          This quest has no subtask plan.
        </CardContent>
      </Card>
    );
  }

  const { parentTask, subtasks, cost, consolidated } = plan;
  const abortReason = (parentTask.executionPreferences?.plan as { abortReason?: string } | undefined)?.abortReason;
  const aborted = parentTask.status === "failed" && !!abortReason;
  // DAG node keys are plan-local ids ("s0", ...) — not db uuids.
  const depths = computePlanDepth(subtasks.map((s) => ({ id: s.planId, dependsOn: s.dependsOn })));
  const byId = new Map(subtasks.map((s) => [s.planId, s]));

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="font-serif-display text-xl">The Plan</CardTitle>
          <div className="flex items-center gap-2">
            <TaskStatusBadge status={parentTask.status} />
            <span className="text-xs text-muted-foreground">{parentTask.title}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Cost: <span className="font-mono">${cost.total.toLocaleString(undefined, { minimumFractionDigits: 4 })}</span>{" "}
            · {cost.inputTokens + cost.outputTokens} tokens
            {cost.estimated ? (
              <Badge variant="outline" className="ml-1 bg-velaris-gold/10 text-velaris-gold">
                estimated
              </Badge>
            ) : null}
          </span>
        </div>
      </CardHeader>
      {aborted ? (
        <div className="px-4 pb-3">
          <AbortVisual reason={abortReason} />
        </div>
      ) : null}
      <CardContent className="space-y-2">
        {depths.lanes.map((lane, laneIdx) => (
          <div
            key={`lane-${laneIdx}`}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
            data-testid={`plan-lane-${laneIdx}`}
          >
            {lane.map((id) => {
              const s = byId.get(id);
              if (!s) return null;
              return <SubtaskCard key={s.id} subtask={s} lane={laneIdx} />;
            })}
          </div>
        ))}

        {consolidated ? (
          <div className="mt-3 space-y-3 rounded-lg border border-border bg-card/40 p-4">
            <h3 className="font-serif-display text-lg text-foreground">Consolidated result</h3>
            {consolidated.summary ? (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{consolidated.summary}</p>
            ) : (
              <p className="text-sm italic text-muted-foreground">No summary was recorded.</p>
            )}
            {consolidated.fileCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                {consolidated.fileCount} file{consolidated.fileCount === 1 ? "" : "s"} changed
              </p>
            ) : null}
            {consolidated.diffPreview ? <DiffViewer content={consolidated.diffPreview} /> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SubtaskCard({ subtask, lane }: { subtask: SubtaskDto; lane: number }) {
  const depIds = subtask.dependsOn;
  return (
    <div
      className="rounded-lg border border-border bg-card/30 p-3"
      data-testid={`subtask-${subtask.planId}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">{subtask.planId}</Badge>
          <span className="font-medium text-foreground">{subtask.title}</span>
        </div>
        <SubtaskStatusBadge status={subtask.status} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {subtask.houseName ? <Badge variant="outline">{subtask.houseName}</Badge> : null}
        {subtask.childTaskStatus ? (
          <span className="font-mono">child: {subtask.childTaskStatus}</span>
        ) : null}
        {subtask.attemptCount > 0 ? (
          <span className="font-mono">attempts: {subtask.attemptCount}</span>
        ) : null}
        <span className="font-mono">depth: {lane}</span>
      </div>

      {depIds.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">depends on</span>
          {depIds.map((d) => (
            <Badge key={d} variant="outline" className="font-mono text-[0.65rem]">
              ← {d}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
