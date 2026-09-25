"use client";

/**
 * Usage & Cost dashboard panel (Phase 6 Stage E) — root dashboard.
 *
 * Read-only view over GET /api/usage. Charts are hand-rolled per Q8: CSS bars
 * for the breakdowns (transform: scaleX — no layout thrash, transform/opacity
 * only) plus an inline SVG sparkline for the time series. NO chart dependency.
 * Reduced motion is honoured by the global rules in globals.css.
 *
 * Double-count note: the payload is aggregated from `usage_records` ONLY; the
 * estimated/reported split is explicit, so the totals reconcile with the
 * provider-reported session mirror rather than summing both sources.
 *
 * Live updates follow the established "event arrived → refetch" pattern: the
 * REST loader is keyed on the shared stream `sequence` (Q10-style, no new SSE
 * event type).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Coins, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import type { UsageBreakdownDto, UsageDashboardDto, UsageSeriesPointDto } from "@/shared/types";

/** Coalesce bursts of stream frames into one refetch (a busy run emits many). */
const REFETCH_DEBOUNCE_MS = 300;

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function tokens(n: number): string {
  return n.toLocaleString();
}

export function UsagePanel() {
  const { sequence } = useVelarisStream();
  const [data, setData] = useState<UsageDashboardDto | null>(null);
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
      const res = await apiFetch<UsageDashboardDto>("/api/usage?bucket=day&taskLimit=10", {
        signal: ctrl.signal,
      });
      setData(res);
    } catch (err) {
      if (ctrl.signal.aborted) return; // superseded/unmounted — no toast
      toast.error(err instanceof Error ? err.message : "Failed to load usage");
    } finally {
      if (!ctrl.signal.aborted) {
        firstLoad.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Mount immediately; a stream frame bumps `sequence` and is debounced so a
  // burst of execution events triggers one request, not one per event.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (sequence === 0) return;
    const timer = setTimeout(() => void load(), REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [load, sequence]);

  const totals = data?.totals;
  const estimatedPct =
    totals && totals.totalCost > 0 ? (totals.estimatedCost / totals.totalCost) * 100 : 0;

  return (
    <Card data-testid="usage-panel">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 font-serif-display text-xl">
              <Coins className="h-5 w-5 text-velaris-gold" /> Usage &amp; Cost
            </CardTitle>
            <CardDescription>
              Aggregated from usage records. Estimated (Ollama) and provider-reported (OpenCode)
              costs are tracked separately and never double-counted.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            data-testid="usage-refresh"
          >
            <RefreshCw className="mr-1 h-4 w-4" /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading && !data ? (
          <p className="text-sm text-muted-foreground">Loading usage…</p>
        ) : !totals || totals.sessions === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="usage-empty">
            No usage recorded yet. Once a house finishes a quest, its cost appears here.
          </p>
        ) : (
          <>
            {/* Cost totals with the estimated/reported split */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Total cost" value={usd(totals.totalCost)} testId="usage-total-cost" />
              <Stat
                label="Provider-reported"
                value={usd(totals.reportedCost)}
                testId="usage-reported-cost"
              />
              <Stat
                label="Estimated"
                value={usd(totals.estimatedCost)}
                testId="usage-estimated-cost"
                accent
              />
              <Stat label="Sessions" value={tokens(totals.sessions)} testId="usage-sessions" />
            </div>

            {/* Stacked estimated-vs-reported bar */}
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>Estimated vs provider-reported</span>
                <span>{estimatedPct.toFixed(1)}% estimated</span>
              </div>
              <div
                className="relative flex h-3 w-full overflow-hidden rounded-full bg-black/30"
                data-testid="usage-split-bar"
                role="img"
                aria-label={`Estimated ${usd(totals.estimatedCost)}, reported ${usd(
                  totals.reportedCost,
                )}`}
              >
                <div
                  className="h-full bg-velaris-gold/70 transition-transform duration-500 motion-reduce:transition-none"
                  style={{
                    width: `${estimatedPct}%`,
                    transformOrigin: "left",
                  }}
                />
                <div className="h-full flex-1 bg-velaris-teal/70" />
              </div>
              <div className="mt-1 flex gap-3 text-[0.7rem] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-velaris-gold/70" />
                  Estimated
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-velaris-teal/70" />
                  Provider-reported
                </span>
              </div>
            </div>

            {/* Token totals */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <KV label="Input tokens" value={tokens(totals.inputTokens)} />
              <KV label="Output tokens" value={tokens(totals.outputTokens)} />
              <KV label="Reasoning" value={tokens(totals.reasoningTokens)} />
              <KV label="Cache reads" value={tokens(totals.cacheReadTokens)} />
            </div>

            {/* Sparkline */}
            {data.series.length > 0 ? (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                  Cost over time
                </div>
                <Sparkline points={data.series} />
              </div>
            ) : null}

            {/* Per-house breakdown */}
            <BreakdownBlock title="By house" rows={data.byHouse} testId="usage-by-house" />

            {/* Per-model breakdown */}
            <BreakdownBlock title="By model" rows={data.byModel} testId="usage-by-model" />

            {/* Per-task breakdown (top N) */}
            <BreakdownBlock title="Top tasks" rows={data.byTask} testId="usage-by-task" />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  testId,
  accent,
}: {
  label: string;
  value: string;
  testId: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`font-mono text-lg ${accent ? "text-velaris-gold" : "text-foreground"}`}
        data-testid={testId}
      >
        {value}
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}

/**
 * Rows of proportional CSS bars. Width is expressed as a normalized percentage
 * of the block's max; the bar is scaled with `transform: scaleX` so only
 * transform/opacity animate (reduced-motion safe). The estimated portion is
 * stacked on the reported portion so the split is visible per row.
 */
function BreakdownBlock({
  title,
  rows,
  testId,
}: {
  title: string;
  rows: UsageBreakdownDto[];
  testId: string;
}) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.totalCost), 0);

  return (
    <div data-testid={testId}>
      <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="space-y-2">
        {rows.map((row) => {
          const pct = max > 0 ? (row.totalCost / max) * 100 : 0;
          const estShare = row.totalCost > 0 ? (row.estimatedCost / row.totalCost) * 100 : 0;
          return (
            <div key={row.key} className="space-y-1" data-testid={`${testId}-row`}>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-foreground">{row.label}</span>
                  {row.provider ? (
                    <span className="text-muted-foreground/70">{row.provider}</span>
                  ) : null}
                  {row.estimated ? (
                    <Badge
                      variant="outline"
                      className="bg-velaris-gold/10 text-velaris-gold"
                      data-testid="usage-estimated-badge"
                    >
                      estimated
                    </Badge>
                  ) : null}
                </span>
                <span className="shrink-0 font-mono text-muted-foreground">{usd(row.totalCost)}</span>
              </div>
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-black/25">
                <div
                  className="absolute inset-y-0 left-0 w-full bg-velaris-teal/60 transition-transform duration-500 motion-reduce:transition-none"
                  style={{ transform: `scaleX(${pct / 100})`, transformOrigin: "left" }}
                />
                {estShare > 0 ? (
                  <div
                    className="absolute inset-y-0 left-0 w-full bg-velaris-gold/80 transition-transform duration-500 motion-reduce:transition-none"
                    style={{
                      transform: `scaleX(${(pct / 100) * (estShare / 100)})`,
                      transformOrigin: "left",
                    }}
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Inline SVG sparkline (no dependency). Plots total cost per bucket as a
 * polyline scaled to the viewBox; aria-hidden because the totals above carry
 * the accessible figures.
 */
function Sparkline({ points }: { points: UsageSeriesPointDto[] }) {
  const W = 320;
  const H = 64;
  const PAD = 4;
  const max = Math.max(...points.map((p) => p.totalCost), 0);
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = PAD + i * step;
    const y = max > 0 ? H - PAD - (p.totalCost / max) * (H - PAD * 2) : H - PAD;
    return { x, y, bucket: p.bucket, cost: p.totalCost };
  });
  const polyline = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ");

  return (
    <div className="rounded-lg border border-border bg-card/40 p-2" data-testid="usage-sparkline">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        role="img"
        aria-label={`Cost over ${points.length} buckets, peak ${usd(max)}`}
      >
        {max > 0 ? (
          <polyline
            points={polyline}
            fill="none"
            stroke="var(--velaris-gold, #e8c66b)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="flex justify-between text-[0.65rem] text-muted-foreground">
        <span>{points[0]?.bucket}</span>
        <span>{points[points.length - 1]?.bucket}</span>
      </div>
    </div>
  );
}
