"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Bird, Castle, Cpu, ScrollText, User } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/houses/status-badge";
import { RuntimeStatusBadge } from "@/components/houses/runtime-status-badge";
import { ApprovalList } from "@/components/approvals/approvals-list";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { HouseDto, HouseRuntimeStatus, HouseDetailDto, HighLordPlanState } from "@/shared/types";

/** The house list enriches each entry with runtime fields (GET /api/houses). */
export interface HouseCardData extends HouseDto {
  runtimeStatus: HouseRuntimeStatus;
  pendingApprovals: number;
  /** Derived High Lord plan state (present on high_lord houses only, D4f). */
  planState?: HighLordPlanState;
}

export function HouseCard({
  house,
  onEdit,
  onToggle,
  onArchive,
  onDelete,
}: {
  house: HouseCardData;
  onEdit: () => void;
  onToggle: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const isArchived = house.status === "archived";
  const isActive = house.status === "active";
  const isDisabled = house.status === "disabled";

  const [birdsOpen, setBirdsOpen] = useState(false);
  // Active task is only present on the detail endpoint — fetched on mount so the
  // card can surface title + status. (List-level runtimeStatus drives the badge.)
  const [activeTask, setActiveTask] = useState<
    HouseDetailDto["activeTask"] | null
  >({ id: null, title: null, status: null });

  useEffect(() => {
    let alive = true;
    apiFetch<{ house: HouseDetailDto }>(`/api/houses/${house.id}`)
      .then((res) => {
        if (alive) setActiveTask(res.house.activeTask);
      })
      .catch(() => {
        /* ignore — card still renders with list-level runtime status */
      });
    return () => {
      alive = false;
    };
  }, [house.id]);

  const hasActiveTask = !!activeTask?.id;

  return (
    <>
      <Card
        className={cn(
          "group flex flex-col transition-colors velaris-card-shadow",
          isArchived && "opacity-60",
          isDisabled && "opacity-70",
        )}
      >
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Castle className="h-5 w-5" />
            </div>
            <div className="flex flex-col items-end gap-1">
              <StatusBadge status={house.status} />
              <RuntimeStatusBadge runtimeStatus={house.runtimeStatus ?? "idle"} />
            </div>
          </div>
          <CardTitle className="font-serif-display text-xl">{house.name}</CardTitle>
          {house.description ? (
            <p className="line-clamp-2 text-sm text-muted-foreground">{house.description}</p>
          ) : null}
        </CardHeader>

        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <User className="h-3.5 w-3.5" />
            <span>
              <span className="font-medium text-foreground">{house.agent.name || "Unnamed"}</span>
              {house.agent.role ? <span className="text-muted-foreground"> · {house.agent.role}</span> : null}
            </span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Cpu className="h-3.5 w-3.5" />
            <span className="truncate">
              {house.configuration.modelId
                ? `${house.configuration.aiProvider || "?"}/${house.configuration.modelId}`
                : "No model set"}
            </span>
          </div>

          {/* Active task */}
          <div className="flex items-center gap-2 text-muted-foreground">
            <ScrollText className="h-3.5 w-3.5" />
            {hasActiveTask ? (
              <span className="min-w-0 flex-1 truncate">
                <span className="text-foreground">{activeTask.title ?? "Untitled quest"}</span>
                <span className="ml-2 text-xs">{activeTask.status ?? ""}</span>
              </span>
            ) : (
              <span className="italic">No active quest</span>
            )}
          </div>

          {/* Messenger bird indicator */}
          {(house.pendingApprovals ?? 0) > 0 ? (
            <button
              type="button"
              onClick={() => setBirdsOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg border border-velaris-gold/40 bg-velaris-gold/10 px-3 py-2 text-left text-sm text-velaris-gold transition-colors hover:bg-velaris-gold/15 status-glow-active"
            >
              <Bird className="h-4 w-4 shrink-0" />
              <span className="font-medium">
                Messenger bird{house.pendingApprovals !== 1 ? "s" : ""} awaiting
              </span>
              <Badge className="ml-auto min-w-5 justify-center" variant="outline">
                {house.pendingApprovals}
              </Badge>
            </button>
          ) : null}
        </CardContent>

        <CardFooter className="mt-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/houses/${house.id}`}>
              <ArrowRight className="h-3.5 w-3.5" /> View
            </Link>
          </Button>
          {!isArchived && (
            <Button variant="outline" size="sm" onClick={onToggle}>
              {isActive ? "Disable" : "Enable"}
            </Button>
          )}
          {!isArchived && (
            <Button variant="outline" size="sm" onClick={onArchive}>
              Archive
            </Button>
          )}
          {isArchived && (
            <Button variant="destructive" size="sm" onClick={onDelete}>
              Delete
            </Button>
          )}
        </CardFooter>
      </Card>

      {/* Approval panel dialog */}
      <Dialog open={birdsOpen} onOpenChange={setBirdsOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-serif-display text-2xl">
              {house.name} — Messenger Roost
            </DialogTitle>
            <DialogDescription>
              Pending approvals for this house. Answer each to let the work continue.
            </DialogDescription>
          </DialogHeader>
          <Separator />
          <ApprovalList houseId={house.id} refreshKey={birdsOpen} bare />
        </DialogContent>
      </Dialog>
    </>
  );
}
