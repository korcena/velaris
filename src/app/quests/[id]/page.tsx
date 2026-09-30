"use client";

/**
 * Quest detail page (`/quests/[id]`) — stacked sections, one scroll:
 *   1. header / details (with a back-link + deleted badge)
 *   2. spin-off flow (the reusable PlanDag, with per-step agents)
 *   3. todos & status (the subtask rows)
 *   4. activity & traces (the /trace rollup, grouped by step)
 *   5. total usage (plan.cost for Court quests, else /api/usage?taskId=)
 *
 * Like the board and Court surfaces it refetches on the shared SSE `sequence`.
 * `notFound()` is not usable from a client component, so an unknown id renders
 * a local not-found state (matching `houses/[id]/page.tsx`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Coins, GitBranch } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { TaskStatusBadge } from "@/components/houses/task-status-badge";
import { PlanDag, SubtaskStatusBadge } from "@/components/court/plan-dag";
import { describeExecutionEvent } from "@/components/houses/activity/describe-event";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import { apiFetch } from "@/lib/api-client";
import type {
  ExecutionEventDto,
  HouseDto,
  PlanDto,
  ProjectDto,
  SubtaskDto,
  TaskDto,
  TaskTraceDto,
  TraceEntryDto,
  UsageTotalsDto,
} from "@/shared/types";

/** Normalized usage shape shared by both sources (plan.cost / usage totals). */
interface UsageView {
  total: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  estimated: boolean;
  /** Present only when sourced from /api/usage (has the explicit split). */
  estimatedCost?: number;
  reportedCost?: number;
}

export default function QuestDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { sequence } = useVelarisStream();

  const [task, setTask] = useState<TaskDto | null>(null);
  const [plan, setPlan] = useState<PlanDto | null>(null);
  const [trace, setTrace] = useState<TaskTraceDto | null>(null);
  const [ownUsage, setOwnUsage] = useState<UsageTotalsDto | null>(null);
  const [houses, setHouses] = useState<HouseDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  // Mirror of `notFound` in a ref: `load` must be able to short-circuit on the
  // SSE-driven refetch without taking `notFound` as a dependency (which would
  // re-create the callback). Once we know the id is gone, refetching would only
  // re-issue five guaranteed-404 requests.
  const notFoundRef = useRef(false);

  const load = useCallback(async () => {
    if (!id || notFoundRef.current) return;
    setLoading(true);
    try {
      const [taskRes, planRes, traceRes, houseRes, projectRes] = await Promise.all([
        apiFetch<{ task: TaskDto }>(`/api/tasks/${id}`),
        apiFetch<{ plan: PlanDto | null }>(`/api/tasks/${id}/plan`),
        apiFetch<{ trace: TaskTraceDto }>(`/api/tasks/${id}/trace`),
        apiFetch<{ houses: HouseDto[] }>("/api/houses?includeArchived=true"),
        apiFetch<{ projects: ProjectDto[] }>("/api/projects"),
      ]);
      setTask(taskRes.task);
      setPlan(planRes.plan);
      setTrace(traceRes.trace);
      setHouses(houseRes.houses);
      setProjects(projectRes.projects);
      setNotFound(false);
      notFoundRef.current = false;
      // Non-Court quest: usage comes from its own taskId (plan.cost would also
      // work but only exists when subtasks do).
      if (planRes.plan === null) {
        const usageRes = await apiFetch<{ totals: UsageTotalsDto }>(
          `/api/usage?taskId=${id}`,
        );
        setOwnUsage(usageRes.totals);
      } else {
        setOwnUsage(null);
      }
    } catch (err) {
      if (err && (err as { status?: number }).status === 404) {
        setNotFound(true);
        notFoundRef.current = true;
        return;
      }
      toast.error(err instanceof Error ? err.message : "Failed to load quest");
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Navigating to a different quest must clear the known-404 latch.
  useEffect(() => {
    notFoundRef.current = false;
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, sequence]);

  const houseName = task?.houseId ? houses.find((h) => h.id === task.houseId)?.name ?? "—" : "—";
  const projectName = task?.projectId
    ? projects.find((p) => p.id === task.projectId)?.name ?? "—"
    : "—";
  const agentName = task?.agentId
    ? houses.flatMap((h) => h.agents ?? []).find((a) => a.id === task.agentId)?.name ?? "—"
    : "default";

  const usage = useMemo<UsageView | null>(() => {
    if (plan) {
      return {
        total: plan.cost.total,
        inputTokens: plan.cost.inputTokens,
        outputTokens: plan.cost.outputTokens,
        reasoningTokens: plan.cost.reasoningTokens,
        cacheReadTokens: plan.cost.cacheReadTokens,
        estimated: plan.cost.estimated ?? false,
      };
    }
    if (ownUsage) {
      return {
        total: ownUsage.totalCost,
        inputTokens: ownUsage.inputTokens,
        outputTokens: ownUsage.outputTokens,
        reasoningTokens: ownUsage.reasoningTokens,
        cacheReadTokens: ownUsage.cacheReadTokens,
        estimated: ownUsage.estimatedCost > 0,
        estimatedCost: ownUsage.estimatedCost,
        reportedCost: ownUsage.reportedCost,
      };
    }
    return null;
  }, [plan, ownUsage]);

  if (notFound) {
    return (
      <div>
        <PageHeader
          title="Quest not found"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link href="/quests">
                <ArrowLeft className="mr-1 h-4 w-4" /> Back to quests
              </Link>
            </Button>
          }
        />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This quest does not exist.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div data-testid="quest-detail-title">
        <PageHeader
          title={task?.title ?? "Quest"}
          subtitle={task?.description || undefined}
          actions={
            <Button asChild variant="outline" size="sm">
              <Link href="/quests">
                <ArrowLeft className="mr-1 h-4 w-4" /> Back to quests
              </Link>
            </Button>
          }
        />
      </div>

      {loading && !task ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Reading the quest…</p>
      ) : task ? (
        <div className="space-y-6">
          {/* 1. Details */}
          <div className="flex flex-wrap items-center gap-2">
            <TaskStatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
            <Badge variant="outline">house: {houseName}</Badge>
            <Badge variant="outline">agent: {agentName}</Badge>
            <Badge variant="outline">project: {projectName}</Badge>
            <span className="text-xs text-muted-foreground">
              created {new Date(task.createdAt).toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">
              updated {new Date(task.updatedAt).toLocaleString()}
            </span>
            {task.deletedAt !== null ? (
              <Badge
                variant="outline"
                className="border-velaris-crimson/40 text-velaris-crimson"
                data-testid="quest-deleted-badge"
              >
                deleted
              </Badge>
            ) : null}
          </div>

          {/* 2. Spin-off flow */}
          <section>
            <h2 className="mb-3 flex items-center gap-2 font-serif-display text-xl text-foreground">
              <GitBranch className="h-5 w-5 text-velaris-purple" /> Spin-off flow
            </h2>
            {plan && plan.subtasks.length > 0 ? (
              <PlanDag plan={plan} showAgents />
            ) : (
              <QuestRootNode task={task} houseName={houseName} agentName={agentName} />
            )}
          </section>

          {/* 3. Todos & status */}
          <section>
            <h2 className="mb-3 font-serif-display text-xl text-foreground">Todos &amp; status</h2>
            {plan && plan.subtasks.length > 0 ? (
              <Card>
                <CardContent className="divide-y divide-border py-0">
                  {plan.subtasks.map((s) => (
                    <TodoRow key={s.id} subtask={s} />
                  ))}
                </CardContent>
              </Card>
            ) : (
              <p className="rounded-lg border border-border bg-card/30 px-4 py-6 text-sm text-muted-foreground">
                This quest has no subtasks.
              </p>
            )}
          </section>

          {/* 4. Activity & traces */}
          <section data-testid="quest-trace">
            <h2 className="mb-3 font-serif-display text-xl text-foreground">Activity &amp; traces</h2>
            <TraceSection entries={trace?.entries ?? []} subtasks={plan?.subtasks ?? []} />
          </section>

          {/* 5. Total usage */}
          <section>
            <h2 className="mb-3 flex items-center gap-2 font-serif-display text-xl text-foreground">
              <Coins className="h-5 w-5 text-velaris-gold" /> Total usage
            </h2>
            <UsageSection usage={usage} />
          </section>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ Sections ----------------------------- */

/** A single node shown when a quest has no subtask plan. */
function QuestRootNode({
  task,
  houseName,
  agentName,
}: {
  task: TaskDto;
  houseName: string;
  agentName: string;
}) {
  return (
    <Card data-testid="quest-flow-root">
      <CardContent className="flex items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            root
          </Badge>
          <span className="font-medium text-foreground">{task.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <TaskStatusBadge status={task.status} />
          <Badge variant="outline">{houseName}</Badge>
          <Badge variant="outline">{agentName}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function TodoRow({ subtask }: { subtask: SubtaskDto }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 py-3"
      data-testid={`quest-todo-${subtask.planId}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant="outline" className="shrink-0 font-mono text-xs">
          {subtask.planId}
        </Badge>
        <span className="truncate text-sm font-medium text-foreground">{subtask.title}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <SubtaskStatusBadge status={subtask.status} />
        <Badge variant="outline">{subtask.agentName ?? "—"}</Badge>
        <Badge variant="outline">{subtask.houseName ?? "—"}</Badge>
        <span className="font-mono">attempts: {subtask.attemptCount}</span>
      </div>
    </div>
  );
}

/** Collapse group: key = subtaskId ?? "root". */
interface TraceGroup {
  key: string;
  label: string;
  agentName: string | null;
  entries: TraceEntryDto[];
}

function TraceSection({
  entries,
  subtasks,
}: {
  entries: TraceEntryDto[];
  subtasks: SubtaskDto[];
}) {
  const groups = useMemo<TraceGroup[]>(() => {
    const byKey = new Map<string, TraceGroup>();
    for (const e of entries) {
      const key = e.subtaskId ?? "root";
      let group = byKey.get(key);
      if (!group) {
        const step = subtasks.find((s) => s.id === e.subtaskId);
        const label =
          key === "root"
            ? "The quest"
            : step
              ? `${step.planId} — ${step.title}`
              : "Delegated step";
        group = { key, label, agentName: e.agentName, entries: [] };
        byKey.set(key, group);
      }
      group.entries.push(e);
    }
    return Array.from(byKey.values());
  }, [entries, subtasks]);

  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card/30 px-4 py-6 text-sm text-muted-foreground">
        No activity recorded yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <details
          key={group.key}
          open={group.key === "root"}
          className="rounded-lg border border-border bg-card/30"
          data-testid={`quest-trace-group-${group.key}`}
        >
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-2 text-sm">
            <span className="font-medium text-foreground">{group.label}</span>
            {group.agentName ? <Badge variant="outline">{group.agentName}</Badge> : null}
            <span className="text-xs text-muted-foreground">
              {group.entries.length} entr{group.entries.length === 1 ? "y" : "ies"}
            </span>
          </summary>
          <ol className="space-y-2 px-4 pb-3">
            {group.entries.map((e) => (
              <TraceRow key={e.id} entry={e} />
            ))}
          </ol>
        </details>
      ))}
    </div>
  );
}

function TraceRow({ entry }: { entry: TraceEntryDto }) {
  if (entry.kind === "message") {
    return (
      <li className="rounded border border-border bg-card/40 px-2 py-1.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            {entry.type}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {new Date(entry.createdAt).toLocaleString()}
          </span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{entry.content}</p>
      </li>
    );
  }

  const item = describeExecutionEvent(toExecutionEvent(entry));
  return (
    <li className="rounded border border-border bg-card/40 px-2 py-1.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="font-mono text-xs">
          {entry.type}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {new Date(entry.createdAt).toLocaleString()}
        </span>
      </div>
      {item ? (
        <p className="mt-1 text-muted-foreground">{item.label}</p>
      ) : null}
      {entry.payload && Object.keys(entry.payload).length > 0 ? (
        <pre className="mt-1 overflow-x-auto text-[0.7rem] text-muted-foreground">
          {JSON.stringify(entry.payload)}
        </pre>
      ) : null}
    </li>
  );
}

/** Adapt a trace event row to the describe helper's input shape. */
function toExecutionEvent(entry: TraceEntryDto): ExecutionEventDto {
  return {
    id: 0,
    sessionId: null,
    taskId: entry.taskId,
    houseId: null,
    rawType: entry.type,
    type: entry.type as ExecutionEventDto["type"],
    payload: entry.payload ?? {},
    createdAt: entry.createdAt,
  };
}

function UsageSection({ usage }: { usage: UsageView | null }) {
  if (!usage) {
    return (
      <p className="rounded-lg border border-border bg-card/30 px-4 py-6 text-sm text-muted-foreground">
        No usage recorded yet.
      </p>
    );
  }

  return (
    <Card data-testid="quest-usage">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="font-serif-display text-xl">
            <span className="font-mono">
              ${usage.total.toLocaleString(undefined, { minimumFractionDigits: 4 })}
            </span>
          </CardTitle>
          {usage.estimated ? (
            <Badge variant="outline" className="bg-velaris-gold/10 text-velaris-gold">
              estimated
            </Badge>
          ) : (
            <Badge variant="outline">provider-reported</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <UsageStat label="Input" value={usage.inputTokens} />
          <UsageStat label="Output" value={usage.outputTokens} />
          <UsageStat label="Reasoning" value={usage.reasoningTokens} />
          <UsageStat label="Cache read" value={usage.cacheReadTokens} />
        </div>
        {usage.estimatedCost !== undefined || usage.reportedCost !== undefined ? (
          <>
            <Separator />
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span>
                estimated:{" "}
                <span className="font-mono text-velaris-gold">
                  ${(usage.estimatedCost ?? 0).toLocaleString(undefined, { minimumFractionDigits: 4 })}
                </span>
              </span>
              <span>
                reported:{" "}
                <span className="font-mono text-foreground">
                  ${(usage.reportedCost ?? 0).toLocaleString(undefined, { minimumFractionDigits: 4 })}
                </span>
              </span>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function UsageStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card/30 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-foreground">{value.toLocaleString()}</div>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: TaskDto["priority"] }) {
  const map = {
    low: { className: "bg-muted text-muted-foreground", label: "low" },
    medium: { className: "bg-velaris-purple/15 text-velaris-purple", label: "medium" },
    high: { className: "bg-velaris-crimson/15 text-velaris-crimson", label: "high" },
    urgent: { className: "bg-velaris-gold/15 text-velaris-gold", label: "urgent" },
  } as const;
  const s = map[priority];
  return (
    <Badge variant="outline" className={s.className}>
      {s.label}
    </Badge>
  );
}
