"use client";

/**
 * House overview (Phase 3) — the default tab of the house detail page.
 * Presentational: renders a HouseDetailDto into four themed cards (Identity,
 * Execution, Workspace, Usage & quest).
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RuntimeStatusBadge } from "@/components/houses/runtime-status-badge";
import type { HouseDetailDto, PermissionMode } from "@/shared/types";

const PERM_STYLE: Record<PermissionMode, string> = {
  allow: "bg-velaris-teal/15 text-velaris-teal",
  ask: "bg-velaris-gold/15 text-velaris-gold",
  deny: "bg-velaris-crimson/15 text-velaris-crimson",
};

const PERM_LABEL: Record<string, string> = {
  fileSystem: "Filesystem",
  shell: "Shell",
  network: "Network",
  git: "Git",
};

export function HouseOverview({ house }: { house: HouseDetailDto }) {
  const cfg = house.configuration;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* Identity */}
      <Card>
        <CardHeader>
          <CardTitle className="font-serif-display text-lg">Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {house.description ? (
            <p className="text-muted-foreground">{house.description}</p>
          ) : (
            <p className="italic text-muted-foreground">No description.</p>
          )}
          <div className="flex items-center gap-2">
            <RuntimeStatusBadge runtimeStatus={house.runtimeStatus} />
          </div>
          <p className="font-serif-display text-xl text-foreground">
            {house.agent.name ?? "Unnamed"}
          </p>
          <p className="text-muted-foreground">{house.agent.role}</p>
        </CardContent>
      </Card>

      {/* Execution */}
      <Card>
        <CardHeader>
          <CardTitle className="font-serif-display text-lg">Execution</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <KV label="Provider" value={cfg.executionProvider} mono />
          <KV
            label="Model"
            value={cfg.modelId ? `${cfg.aiProvider}/${cfg.modelId}` : "No model set"}
            mono
          />
          <KV label="Approval policy" value={cfg.approvalPolicy} />
          <KV label="Concurrency" value={String(cfg.concurrency)} />
          <div className="flex flex-wrap gap-1 pt-1">
            {cfg.tools?.length ? (
              cfg.tools.map((t) => (
                <Badge key={t} variant="outline">
                  {t}
                </Badge>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">No tools</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Workspace & permissions */}
      <Card>
        <CardHeader>
          <CardTitle className="font-serif-display text-lg">Workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Allowlist
            </div>
            {cfg.workspaceAllowlist?.length ? (
              <div className="space-y-1">
                {cfg.workspaceAllowlist.map((p) => (
                  <p key={p} className="truncate rounded bg-black/20 px-2 py-1 font-mono text-xs text-muted-foreground">
                    {p}
                  </p>
                ))}
              </div>
            ) : (
              <p className="italic text-muted-foreground">No workspace paths.</p>
            )}
          </div>
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Permissions
            </div>
            <div className="flex flex-wrap gap-1">
              {configPermissions(cfg).map(([key, mode]) => (
                <Badge key={key} variant="outline" className={PERM_STYLE[mode]}>
                  {PERM_LABEL[key] ?? key}: {mode}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Usage & quest */}
      <Card>
        <CardHeader>
          <CardTitle className="font-serif-display text-lg">Usage & quest</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <KV label="Cost" value={`$${house.usage.total.toFixed(4)}`} />
            <KV label="Sessions" value={String(house.usage.sessions)} />
            <KV label="Input tokens" value={house.usage.inputTokens.toLocaleString()} />
            <KV label="Output tokens" value={house.usage.outputTokens.toLocaleString()} />
            <KV label="Reasoning" value={house.usage.reasoningTokens.toLocaleString()} />
            <KV label="Cache reads" value={house.usage.cacheReadTokens.toLocaleString()} />
          </div>
          <div className="pt-2">
            {house.activeTask?.id ? (
              <div className="rounded-lg border border-border bg-card/30 px-3 py-2">
                <div className="text-xs text-muted-foreground">Active quest</div>
                <div className="font-medium text-foreground">
                  {house.activeTask.title ?? "Untitled"}
                </div>
                {house.activeTask.status ? (
                  <Badge variant="outline" className="mt-1">
                    {house.activeTask.status}
                  </Badge>
                ) : null}
              </div>
            ) : (
              <p className="italic text-muted-foreground">No active quest.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={mono ? "truncate font-mono text-xs text-foreground" : "text-sm text-foreground"}>
        {value}
      </span>
    </div>
  );
}

/** Defensive accessor: HouseDetailDto.configuration has no `agentName` field,
 * so this reads only the real config fields (typed below). */
function configPermissions(cfg: HouseDetailDto["configuration"]) {
  const perms = cfg.permissions ?? {};
  return Object.entries(perms) as Array<[string, PermissionMode]>;
}
