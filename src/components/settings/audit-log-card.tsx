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
import { Download, RefreshCw } from "lucide-react";
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
import type { AuditEntityType, AuditLogDto, ProviderConfigDto } from "@/shared/types";

const ALL = "all";

/** Retention options for the default OpenCode provider's `extra.audit`. */
const RETENTION_OPTIONS = [
  { value: "0", label: "Keep forever" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "365 days" },
] as const;

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
  // Retention (days) on the default OpenCode provider's `extra.audit`.
  const [retentionDays, setRetentionDays] = useState("0");
  const [opencode, setOpencode] = useState<ProviderConfigDto | null>(null);
  const [retentionLoaded, setRetentionLoaded] = useState(false);

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

  /** Load the default OpenCode provider's configured audit retention. */
  const loadRetention = useCallback(async () => {
    try {
      const res = await apiFetch<{ providerConfigs: ProviderConfigDto[] }>("/api/provider-configs");
      const opencodeCfg = res.providerConfigs.find((c) => c.type === "opencode" && c.isDefault)
        ?? res.providerConfigs.find((c) => c.type === "opencode")
        ?? null;
      setOpencode(opencodeCfg);
      const audit = (opencodeCfg?.extra?.audit as { retentionDays?: unknown } | undefined);
      const days = audit?.retentionDays;
      setRetentionDays(typeof days === "number" && Number.isFinite(days) && days > 0 ? String(days) : "0");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load audit retention");
    } finally {
      setRetentionLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load(entityType);
  }, [entityType, load]);

  useEffect(() => {
    void loadRetention();
  }, [loadRetention]);

  async function saveRetention(value: string) {
    if (!opencode) {
      toast.error("No OpenCode provider config found");
      return;
    }
    const previous = retentionDays;
    setRetentionDays(value);
    try {
      const res = await apiFetch<{ providerConfig: ProviderConfigDto }>(
        `/api/provider-configs/${opencode.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            extra: { ...(opencode.extra ?? {}), audit: { retentionDays: Number(value) } },
          }),
        },
      );
      setOpencode(res.providerConfig);
      const audit = (res.providerConfig.extra?.audit as { retentionDays?: unknown } | undefined);
      const days = audit?.retentionDays;
      setRetentionDays(typeof days === "number" && Number.isFinite(days) && days > 0 ? String(days) : "0");
      toast.success(value === "0" ? "Audit log retention: keep forever" : `Audit log retention: ${value} days`);
    } catch (err) {
      setRetentionDays(previous);
      toast.error(err instanceof Error ? err.message : "Failed to save audit retention");
    }
  }

  /** Build the current-filter export href (plain anchor download). */
  function exportHref(format: "csv" | "json"): string {
    const params = new URLSearchParams({ format });
    if (entityType !== ALL) params.set("entityType", entityType);
    return `/api/audit-log/export?${params.toString()}`;
  }

  return (
    <Card data-testid="audit-log-card">
      <CardHeader>
        <CardTitle className="font-serif-display text-xl">Audit Log</CardTitle>
        <CardDescription>
          Record of user actions on houses, agents, projects, provider configs, templates and
          approval responses. Read-only; retained indefinitely unless a retention window is set.
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
          <Button asChild variant="outline" size="sm" data-testid="audit-log-export-csv">
            <a href={exportHref("csv")} download>
              <Download className="mr-1 h-4 w-4" /> Export CSV
            </a>
          </Button>
          <Button asChild variant="outline" size="sm" data-testid="audit-log-export-json">
            <a href={exportHref("json")} download>
              <Download className="mr-1 h-4 w-4" /> Export JSON
            </a>
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/40 p-3">
          <div>
            <p className="font-medium text-foreground">Retention</p>
            <p className="text-xs text-muted-foreground">
              Keep forever by default. A window requires the engine to be running: it prunes audit
              rows older than the window once at boot, then at most hourly.
            </p>
          </div>
          <Select
            value={retentionDays}
            onValueChange={(v) => void saveRetention(v)}
            disabled={!retentionLoaded || !opencode}
          >
            <SelectTrigger className="w-[10rem]" aria-label="Audit log retention">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RETENTION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
