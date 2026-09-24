"use client";

/**
 * High Lord's Court (Phase 4) — replaces the placeholder with the Court chat +
 * plan board. The composer steers an active plan or starts a new instruction;
 * the plan board renders the live subtask DAG keyed on the realtime stream.
 */

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { CourtChat } from "@/components/court/court-chat";
import { PlanBoard } from "@/components/court/plan-board";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import { apiFetch } from "@/lib/api-client";
import type { TaskDto } from "@/shared/types";

export default function HighLordsCourtPage() {
  const { sequence } = useVelarisStream();
  const [highLordHouseId, setHighLordHouseId] = useState<string | null>(null);
  // The latest High Lord parent task id — the plan board's active target.
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  // Whether the tracked parent task is terminal (→ new instruction instead of steer).
  const [activePlanTerminal, setActivePlanTerminal] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ messages: unknown[]; highLordHouseId: string | null }>(
        "/api/court/history",
      );
      const hlId = res.highLordHouseId;
      setHighLordHouseId(hlId);
      if (!hlId) {
        setActivePlanId(null);
        setActivePlanTerminal(false);
        return;
      }
      // The High Lord's parent tasks, newest-first (listTasks sorts createdAt DESC).
      const tasks = await apiFetch<{ tasks: TaskDto[] }>(`/api/tasks?houseId=${hlId}`);
      const latest = tasks.tasks[0];
      if (latest) {
        setActivePlanId(latest.id);
        setActivePlanTerminal(isTerminalStatus(latest.status));
      } else {
        setActivePlanId(null);
        setActivePlanTerminal(false);
      }
    } catch {
      setHighLordHouseId(null);
      setActivePlanId(null);
      setActivePlanTerminal(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, sequence]);

  // After a new instruction is created, set it as the active plan for the board.
  const handlePlanCreated = useCallback((taskId: string) => {
    setActivePlanId(taskId);
    setActivePlanTerminal(false);
  }, []);

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeader
        title="High Lord's Court"
        subtitle="Speak to the High Lord — instructions become plans, plans become quests."
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-h-0">
          <CourtChat
            highLordHouseId={highLordHouseId}
            activePlanId={activePlanTerminal ? null : activePlanId}
            onPlanCreated={handlePlanCreated}
          />
        </div>
        <div className="min-h-0">
          <PlanBoard parentTaskId={activePlanId} refreshKey={sequence} />
        </div>
      </div>
    </div>
  );
}

function isTerminalStatus(status: TaskDto["status"]): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}
