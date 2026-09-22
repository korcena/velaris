"use client";

/**
 * Approval history (Phase 3) — read-only list of a house/all resolved approvals.
 * Fetches GET /api/approvals (all statuses) and renders the non-pending ones.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Castle, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api-client";
import type { ApprovalRequestDto } from "@/shared/types";

const STATUS_STYLE: Record<string, string> = {
  approved: "bg-velaris-teal/15 text-velaris-teal",
  rejected: "bg-velaris-crimson/15 text-velaris-crimson",
  replied: "bg-velaris-silver-muted/15 text-velaris-silver-muted",
  cancelled: "bg-velaris-crimson/15 text-velaris-crimson",
};

export function ApprovalHistory({
  refreshKey,
  houseId,
}: {
  refreshKey?: unknown;
  houseId?: string;
}) {
  const [resolved, setResolved] = useState<ApprovalRequestDto[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // GET /api/approvals with no status param returns ALL requests.
      const res = await apiFetch<{ approvals: ApprovalRequestDto[] }>("/api/approvals");
      let list = res.approvals.filter((a) => a.status !== "pending");
      if (houseId) list = list.filter((a) => a.houseId === houseId);
      setResolved(list);
    } catch {
      setResolved([]);
    } finally {
      setLoading(false);
    }
  }, [houseId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (loading) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Gathering the court records…</p>;
  }

  if (resolved.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">No resolved approvals yet.</p>
    );
  }

  return (
    <div className="space-y-2">
      {resolved.map((a) => (
        <div key={a.id} className="rounded-lg border border-border bg-card/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <History className="h-3.5 w-3.5 shrink-0 text-velaris-silver-muted" />
              <span className="truncate text-sm font-medium text-foreground">{a.title}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="outline">{a.kind}</Badge>
              <Badge variant="outline" className={STATUS_STYLE[a.status] ?? ""}>
                {a.status}
              </Badge>
            </div>
          </div>
          {a.message ? (
            <p className="mt-1 text-sm text-muted-foreground">{a.message}</p>
          ) : null}
          {a.response ? (
            <p className="mt-1 rounded bg-black/20 px-2 py-1 text-sm text-foreground/80">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Response: </span>
              {a.response}
            </p>
          ) : null}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {a.respondedAt ? new Date(a.respondedAt).toLocaleString() : new Date(a.createdAt).toLocaleString()}
            </span>
            {a.houseId ? (
              <Link
                href={`/houses/${a.houseId}`}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Castle className="h-3 w-3" /> View house
              </Link>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
