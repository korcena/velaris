/**
 * Monitoring service (Phase 6 Stage F) — read-only engine/queue/error snapshot.
 *
 * Sources (all existing reads, no new writer):
 *  - `engine_state`: heartbeat, version, OpenCode server pid.
 *  - `tasks`: queue depth (`queued`) and running count (`running`).
 *  - `execution_events`: 24h error/failure/total counts.
 *  - OpenCode health: best-effort web-side probe, mirroring the `/api/models`
 *    convention. Unreachable ⇒ `providerHealth: false` (never throws).
 *
 * Liveness threshold: the engine upserts its heartbeat every 5s (main.ts), so a
 * heartbeat older than 15s (~3 missed writes) is `stale`; absent is `offline`.
 * `engineHealth` is derived server-side so the UI and tests agree on the rule.
 *
 * Q10: this is strictly REST; no SSE event type is added (the panels use the
 * established "event arrived → refetch" pattern / a 5s poll).
 */

import type { VelarisDb } from "@/lib/db";
import { getEngineStateKey, countEventsByTypeSince } from "@/server/repositories/execution-repo";
import { countTasksByStatus } from "@/server/repositories/task-repo";
import { EXECUTION_EVENT_TYPES } from "@/shared/constants";
import type { EngineHealth, MonitoringDto } from "@/shared/types";

const HEARTBEAT_STALE_MS = 15_000;
const ENGINE_HEARTBEAT_KEY = "engine_heartbeat_at";
const ENGINE_VERSION_KEY = "engine_version";
const OPENCODE_PID_KEY = "opencode_server_pid";

/** Derive liveness from heartbeat age (null age ⇒ engine never ran). */
export function deriveEngineHealth(heartbeatAgeMs: number | null): EngineHealth {
  if (heartbeatAgeMs === null) return "offline";
  if (heartbeatAgeMs > HEARTBEAT_STALE_MS) return "stale";
  return "online";
}

/** Milliseconds since an ISO timestamp; null when missing/invalid. */
export function heartbeatAgeMs(heartbeatAt: string | null, nowMs = Date.now()): number | null {
  if (!heartbeatAt) return null;
  const t = Date.parse(heartbeatAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

export interface BuildMonitoringOptions {
  /** Probe OpenCode health. Omitted ⇒ treated as unreachable (false). */
  probeProviderHealth?: () => Promise<boolean>;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/**
 * Assemble the monitoring payload. The provider probe is best-effort: any
 * throw/rejection degrades to `false` so an unreachable OpenCode server never
 * fails the whole dashboard request (engine-off e2e).
 */
export async function buildMonitoring(
  db: VelarisDb,
  opts: BuildMonitoringOptions = {},
): Promise<MonitoringDto> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const since24h = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

  const engineHeartbeatAt = getEngineStateKey(db, ENGINE_HEARTBEAT_KEY);
  const engineVersion = getEngineStateKey(db, ENGINE_VERSION_KEY);
  const opencodeServerPid = getEngineStateKey(db, OPENCODE_PID_KEY);
  const ageMs = heartbeatAgeMs(engineHeartbeatAt, nowMs);

  let providerHealth = false;
  if (opts.probeProviderHealth) {
    try {
      providerHealth = await opts.probeProviderHealth();
    } catch {
      providerHealth = false;
    }
  }

  return {
    engineHeartbeatAt,
    heartbeatAgeMs: ageMs,
    engineVersion,
    opencodeServerPid,
    queueDepth: countTasksByStatus(db, "queued"),
    runningCount: countTasksByStatus(db, "running"),
    errorsLast24h: countEventsByTypeSince(db, ["error"], since24h),
    failuresLast24h: countEventsByTypeSince(db, ["task_failed"], since24h),
    // Canonical list (mirrors the execution_events CHECK) — never hardcoded here,
    // so a new event type cannot silently drop out of the total.
    eventsLast24h: countEventsByTypeSince(db, [...EXECUTION_EVENT_TYPES], since24h),
    providerHealth,
    engineHealth: deriveEngineHealth(ageMs),
    checkedAt: now.toISOString(),
  };
}
