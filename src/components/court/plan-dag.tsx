"use client";

/**
 * Presentational plan DAG (extracted from plan-board.tsx for reuse).
 *
 * Layers a High Lord's subtasks by dependency depth. Parallel siblings share a
 * row. Shows plan-id chips, destination house names, status badges, attempt
 * counts, dependency chips, a cost rollup, and a consolidated summary +
 * DiffViewer when the parent is terminal. When the plan aborted (parent failed
 * with execution_preferences.plan.abortReason) a burning-castle strip
 * (AbortVisual) tops the board.
 *
 * `showAgents` (default false) adds the per-step agent chip; the Court board
 * leaves it off so its DOM is unchanged.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TaskStatusBadge } from "@/components/houses/task-status-badge";
import { DiffViewer } from "@/components/houses/results/diff-viewer";
import { AbortVisual } from "./abort-visual";
import { computePlanDepth } from "./plan-depth";
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

export function SubtaskStatusBadge({ status }: { status: SubtaskStatus }) {
  const s = SUBTASK_STYLES[status];
  return <Badge variant="outline" className={s?.className}>{s?.label ?? status}</Badge>;
}

export function PlanDag({ plan, showAgents = false }: { plan: PlanDto; showAgents?: boolean }) {
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
              return <SubtaskCard key={s.id} subtask={s} lane={laneIdx} showAgents={showAgents} />;
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

function SubtaskCard({ subtask, lane, showAgents = false }: { subtask: SubtaskDto; lane: number; showAgents?: boolean }) {
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
        {showAgents && subtask.agentName ? (
          <Badge variant="outline">{subtask.agentName}</Badge>
        ) : null}
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
