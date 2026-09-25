"use client";

/**
 * Read-only Settings card surfacing the audit trail (Phase 6 Stage A).
 *
 * Web user-action rows only (house/agent/project/provider-config/template CRUD
 * + approval responses). Engine execution lifecycle lives in execution_events
 * and is deliberately not shown here.
 *
 * Styling follows the existing Settings cards. Only opacity/background
 * transitions are used (no transforms), so reduced-motion is honoured by the
 * global rules in globals.css.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/api-client";
import { AUDIT_ENTITY_TYPES } from "@/shared/constants";
import type { AuditEntityType, AuditLogDto } from "@/shared/types";

const ALL = "all";

/** A compact, human-readable hint from the entry's metadata (no raw JSON dump). */
function summarize(entry: AuditLogDto): string | null {
  const meta = entry.metadata;
  if (typeof meta.name === "string" && meta.name) return meta.name;
  if (Array.isArray(meta.changed) && meta.changed.length) {
    return `changed: ${meta.changed.join(", ")}`;
  }
  if (typeof meta.status === "string" && meta.status) return `status → ${meta.status}`;
  return null;
}

export function AuditLogCard() {
  const [entries, setEntries] = useState<AuditLogDto[]>([]);
  const [entityType, setEntityType] = useState<AuditEntityType | typeof ALL>(ALL);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (filter: AuditEntityType | typeof ALL) => {
      setLoading(true);
      try {
        const query = filter === ALL ? "" : `?entityType=${encodeURIComponent(filter)}&limit=25`;
        const res = await apiFetch<{ entries: AuditLogDto[] }>(`/api/audit-log${query}`);
        setEntries(res.entries);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load audit log");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(entityType);
  }, [entityType, load]);

  return (
    <Card data-testid="audit-log-card">
      <CardHeader>
        <CardTitle className="font-serif-display text-xl">Audit Log</CardTitle>
        <CardDescription>
          Record of user actions on houses, agents, projects, provider configs, templates and
          approval responses. Read-only and retained indefinitely.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={entityType}
            onValueChange={(v) => setEntityType(v as AuditEntityType | typeof ALL)}
          >
            <SelectTrigger className="w-[12rem]" aria-label="Filter audit log by entity type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All entities</SelectItem>
              {AUDIT_ENTITY_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(entityType)}
            disabled={loading}
            data-testid="audit-log-refresh"
          >
            <RefreshCw className="mr-1 h-4 w-4" /> Refresh
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading audit entries…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="audit-log-empty">
            No audit entries yet.
          </p>
        ) : (
          <div className="space-y-2" data-testid="audit-log-entries">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/40 p-3"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="outline">{entry.entityType}</Badge>
                  <span className="font-medium text-foreground">{entry.action}</span>
                  {summarize(entry) ? (
                    <span className="truncate text-xs text-muted-foreground">{summarize(entry)}</span>
                  ) : null}
                  {entry.entityId ? (
                    <span className="truncate font-mono text-xs text-muted-foreground/70">
                      {entry.entityId}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={entry.actor === "engine" ? "secondary" : "default"}>
                    {entry.actor}
                  </Badge>
                  <time dateTime={entry.createdAt}>{entry.createdAt}</time>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
