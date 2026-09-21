"use client";

import { Castle, Cpu, User } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/houses/status-badge";
import { cn } from "@/lib/utils";
import type { HouseDto } from "@/shared/types";

export function HouseCard({
  house,
  onEdit,
  onToggle,
  onArchive,
  onDelete,
}: {
  house: HouseDto;
  onEdit: () => void;
  onToggle: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const isArchived = house.status === "archived";
  const isActive = house.status === "active";
  const isDisabled = house.status === "disabled";

  return (
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
          <StatusBadge status={house.status} />
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
      </CardContent>

      <CardFooter className="mt-auto flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit
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
  );
}

