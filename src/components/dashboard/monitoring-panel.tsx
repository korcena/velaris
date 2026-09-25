"use client";

/**
 * Monitoring panel (Phase 6 Stage F) — root dashboard.
 *
 * Read-only engine health / queue depth / error rates over GET /api/monitoring.
 * Q10: REST polling (~5s), NOT a new SSE event type (no CHECK migration). The
 * established "event arrived → refetch" pattern is also wired via the shared
 * stream `sequence`, so an execution/notification frame refreshes promptly.
 *
 * Engine-off empty state is essential: the e2e environment never starts the
 * engine, so a null heartbeat must render "engine offline" rather than error.
 * Only opacity/transform transitions are used; reduced motion is honoured by
 * globals.css.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import type { EngineHealth, MonitoringDto } from "@/shared/types";

const POLL_MS = 5_000;
/** Coalesce bursts of stream frames into one refetch (a busy run emits many). */
const REFETCH_DEBOUNCE_MS = 300;

const HEALTH_STYLE: Record<EngineHealth, string> = {
  online: "bg-velaris-teal/15 text-velaris-teal",
  stale: "bg-velaris-gold/15 text-velaris-gold",
  offline: "bg-velaris-crimson/15 text-velaris-crimson",
};

const HEALTH_LABEL: Record<EngineHealth, string> = {
  online: "online",
  stale: "stale",
  offline: "offline",
};

function age(ms: number | null): string {
  if (ms === null) return "never";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function MonitoringPanel() {
  const { sequence } = useVelarisStream();
  const [data, setData] = useState<MonitoringDto | null>(null);
  const [loading, setLoading] = useState(true);
  const firstLoad = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (firstLoad.current) setLoading(true);
    // Cancel any superseded request so a slow response cannot overwrite newer data.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await apiFetch<MonitoringDto>("/api/monitoring", { signal: ctrl.signal });
      setData(res);
    } catch (err) {
      if (ctrl.signal.aborted) return; // superseded/unmounted — no toast
      toast.error(err instanceof Error ? err.message : "Failed to load monitoring");
    } finally {
      if (!ctrl.signal.aborted) {
        firstLoad.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Refetch on mount immediately; a stream frame bumps `sequence` and is
  // debounced so a burst of execution events triggers one request, not one per
  // event.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (sequence === 0) return;
    const timer = setTimeout(() => void load(), REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [load, sequence]);

  useEffect(() => {
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const health = data?.engineHealth ?? "offline";

  return (
    <Card data-testid="monitoring-panel">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 font-serif-display text-xl">
              <Activity className="h-5 w-5 text-velaris-teal" /> Engine Monitor
            </CardTitle>
            <CardDescription>
              Engine health, queue depth and error rates. Read-only; polls every {POLL_MS / 1000}s.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={HEALTH_STYLE[health]}
              data-testid="monitoring-engine-health"
            >
              engine {HEALTH_LABEL[health]}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
              data-testid="monitoring-refresh"
            >
              <RefreshCw className="mr-1 h-4 w-4" /> Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {data === null ? (
          <p className="text-sm text-muted-foreground">Loading monitor…</p>
        ) : health === "offline" ? (
          <div className="space-y-1" data-testid="monitoring-offline">
            <p className="text-sm text-muted-foreground">
              The engine appears offline — it has not reported a heartbeat yet.
            </p>
            <p className="text-xs text-muted-foreground/70">
              Start the engine (<code className="font-mono">npm run dev</code>) to see live queue
              and error metrics.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Heartbeat"
                value={age(data.heartbeatAgeMs)}
                testId="monitoring-heartbeat-age"
              />
              <Stat
                label="Queue depth"
                value={String(data.queueDepth)}
                testId="monitoring-queue-depth"
              />
              <Stat
                label="Running"
                value={String(data.runningCount)}
                testId="monitoring-running"
              />
              <Stat
                label="Events (24h)"
                value={data.eventsLast24h.toLocaleString()}
                testId="monitoring-events-24h"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Errors (24h)"
                value={String(data.errorsLast24h)}
                testId="monitoring-errors-24h"
                danger={data.errorsLast24h > 0}
              />
              <Stat
                label="Failures (24h)"
                value={String(data.failuresLast24h)}
                testId="monitoring-failures-24h"
                danger={data.failuresLast24h > 0}
              />
              <Stat
                label="OpenCode"
                value={data.providerHealth ? "healthy" : "unreachable"}
                testId="monitoring-provider-health"
              />
              <Stat
                label="Version"
                value={data.engineVersion ?? "—"}
                testId="monitoring-engine-version"
              />
            </div>

            <p className="text-[0.7rem] text-muted-foreground/70" data-testid="monitoring-checked-at">
              checked {data.checkedAt}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  testId,
  danger,
}: {
  label: string;
  value: string;
  testId: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`font-mono text-lg ${danger ? "text-velaris-crimson" : "text-foreground"}`}
        data-testid={testId}
      >
        {value}
      </div>
    </div>
  );
}
