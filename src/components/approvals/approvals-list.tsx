"use client";

/**
 * Reusable pending-approvals list (Jobs B/C/E).
 *
 * Fetches `GET /api/approvals?status=pending` and renders each request via the
 * shared <ApprovalCard>. When `houseId` is provided the list is filtered to
 * that house (the API exposes only a status filter, so we filter client-side).
 * `refreshKey` acts as an external refetch trigger — bump it (e.g. on a
 * realtime tick or after a page action) to reload the list.
 */

import { useEffect, useState, useCallback } from "react";
import { Bird } from "lucide-react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { Card, CardContent } from "@/components/ui/card";
import { apiFetch } from "@/lib/api-client";
import type { ApprovalRequestDto } from "@/shared/types";

interface Props {
  houseId?: string;
  /** Bump to trigger a refetch (sequence tick, local state change). */
  refreshKey?: unknown;
  /** Render without wrapping Card chrome (for embedding in dialogs/tabs). */
  bare?: boolean;
}

export function ApprovalList({ houseId, refreshKey, bare }: Props) {
  const [approvals, setApprovals] = useState<ApprovalRequestDto[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ approvals: ApprovalRequestDto[] }>(
        "/api/approvals?status=pending",
      );
      const filtered = houseId
        ? res.approvals.filter((a) => a.houseId === houseId)
        : res.approvals;
      setApprovals(filtered);
    } catch {
      setApprovals([]);
    } finally {
      setLoading(false);
    }
  }, [houseId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const content = (
    <div className="space-y-2">
      {loading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Listening for birds…
        </p>
      ) : approvals.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <Bird className="h-6 w-6 text-velaris-silver-muted" />
          <p className="text-sm text-muted-foreground">
            No pending approvals{houseId ? " for this house" : ""}.
          </p>
        </div>
      ) : (
        approvals.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} onResponded={load} />
        ))
      )}
    </div>
  );

  if (bare) return content;

  return (
    <Card>
      <CardContent className="pt-6">{content}</CardContent>
    </Card>
  );
}
