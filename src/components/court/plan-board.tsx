"use client";

/**
 * Court plan board (Phase 4 §7.2 + addendum D2d/D4e) — fetch wrapper around the
 * presentational `PlanDag` (extracted so the quest detail page can reuse the
 * same DAG with per-step agents). Behaviour/branches for the High Lord page are
 * unchanged: same loading/empty/no-plan copy and the same plan rendering.
 */

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { PlanDag } from "./plan-dag";
import { apiFetch } from "@/lib/api-client";
import type { PlanDto } from "@/shared/types";

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

  return <PlanDag plan={plan} />;
}
