/**
 * Usage aggregation repository (Phase 6 Stage E) — read-only GROUP BY helpers
 * over `usage_records`.
 *
 * DOUBLE-COUNTING GUARD (plan §16 risk 4 — the real risk):
 * Every terminal session writes EXACTLY ONE `usage_records` row, then mirrors
 * the same cost/tokens onto `execution_sessions.cost_total`/`tokens_*`. Any
 * aggregate that sums BOTH sources double-counts. Every query here therefore
 * reads FROM `usage_records` ONLY. Joins to `houses`/`tasks` are on their
 * primary keys (1:1), so they can never multiply usage rows. A regression test
 * asserts the partition invariant (`byHouse`/`byModel`/`byTask` each sum to
 * `totals`) and that the session-mirror sum equals — not doubles — the usage
 * total.
 *
 * The estimated-vs-reported split is `SUM(CASE WHEN estimated=1 THEN cost)` vs
 * `estimated=0`; `estimated=1` is always an Ollama local estimate, `0` always a
 * provider-reported (OpenCode) cost. No writes, no engine coupling.
 */

import { rawDb, type VelarisDb } from "@/lib/db";
import type {
  UsageBreakdownDto,
  UsageSeriesPointDto,
  UsageTotalsDto,
} from "@/shared/types";

/** Filters shared by every aggregate. Omitted filters are not applied. */
export interface UsageFilters {
  houseId?: string;
  taskId?: string;
  modelId?: string;
  provider?: string;
  from?: string;
  to?: string;
}

/** SQLite returns numbers for SUM/COUNT; normalize defensively. */
function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Build the WHERE clause + bound params from the optional filters. */
function buildWhere(filters: UsageFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.houseId) {
    clauses.push("u.house_id = ?");
    params.push(filters.houseId);
  }
  if (filters.taskId) {
    clauses.push("u.task_id = ?");
    params.push(filters.taskId);
  }
  if (filters.modelId) {
    clauses.push("u.model_id = ?");
    params.push(filters.modelId);
  }
  if (filters.provider) {
    clauses.push("u.provider = ?");
    params.push(filters.provider);
  }
  if (filters.from) {
    clauses.push("u.created_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("u.created_at <= ?");
    params.push(filters.to);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Shared SUM/COUNT projection so every aggregate splits estimates identically. */
const AGG_COLUMNS = `
  COALESCE(SUM(u.cost), 0) AS totalCost,
  COALESCE(SUM(CASE WHEN u.estimated = 1 THEN u.cost END), 0) AS estimatedCost,
  COALESCE(SUM(CASE WHEN u.estimated = 0 THEN u.cost END), 0) AS reportedCost,
  COALESCE(SUM(u.input_tokens), 0) AS inputTokens,
  COALESCE(SUM(u.output_tokens), 0) AS outputTokens,
  COALESCE(SUM(u.reasoning_tokens), 0) AS reasoningTokens,
  COALESCE(SUM(u.cache_read_tokens), 0) AS cacheReadTokens,
  COUNT(*) AS sessions,
  COALESCE(SUM(CASE WHEN u.estimated = 1 THEN 1 ELSE 0 END), 0) AS estimatedRows
`;

interface RawTotals {
  totalCost: unknown;
  estimatedCost: unknown;
  reportedCost: unknown;
  inputTokens: unknown;
  outputTokens: unknown;
  reasoningTokens: unknown;
  cacheReadTokens: unknown;
  sessions: unknown;
}

function toTotals(row: RawTotals | undefined): UsageTotalsDto {
  return {
    totalCost: num(row?.totalCost),
    estimatedCost: num(row?.estimatedCost),
    reportedCost: num(row?.reportedCost),
    inputTokens: num(row?.inputTokens),
    outputTokens: num(row?.outputTokens),
    reasoningTokens: num(row?.reasoningTokens),
    cacheReadTokens: num(row?.cacheReadTokens),
    sessions: num(row?.sessions),
  };
}

interface RawBreakdown extends RawTotals {
  houseId?: string | null;
  houseName?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  provider?: string | null;
  modelId?: string | null;
  estimatedRows?: unknown;
}

function toBreakdown(row: RawBreakdown, kind: "house" | "model" | "task"): UsageBreakdownDto {
  const houseId = row.houseId ?? null;
  const taskId = row.taskId ?? null;
  const provider = row.provider ?? null;
  const modelId = row.modelId ?? null;

  let key: string;
  let label: string;
  if (kind === "house") {
    key = houseId ?? "__unassigned__";
    label = row.houseName ?? houseId ?? "Unassigned";
  } else if (kind === "model") {
    key = `${provider ?? "unknown"}/${modelId ?? "unknown"}`;
    label = modelId || "(no model)";
  } else {
    key = taskId ?? "__unassigned__";
    label = row.taskTitle ?? taskId ?? "Unassigned task";
  }

  return {
    key,
    label,
    houseId,
    taskId,
    provider,
    modelId,
    totalCost: num(row.totalCost),
    estimatedCost: num(row.estimatedCost),
    reportedCost: num(row.reportedCost),
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    reasoningTokens: num(row.reasoningTokens),
    cacheReadTokens: num(row.cacheReadTokens),
    sessions: num(row.sessions),
    estimated: num(row.estimatedRows) > 0,
  };
}

/** Aggregate totals over every matched usage row. Invariant: total = est + reported. */
export function getUsageTotals(db: VelarisDb, filters: UsageFilters = {}): UsageTotalsDto {
  const { sql, params } = buildWhere(filters);
  const row = rawDb(db)
    .prepare(`SELECT ${AGG_COLUMNS} FROM usage_records u ${sql}`)
    .get(...params) as RawTotals | undefined;
  return toTotals(row);
}

/** Totals grouped by house (LEFT JOIN houses for the display name — PK join). */
export function getUsageByHouse(
  db: VelarisDb,
  filters: UsageFilters = {},
): UsageBreakdownDto[] {
  const { sql, params } = buildWhere(filters);
  const rows = rawDb(db)
    .prepare(
      `SELECT u.house_id AS houseId, h.name AS houseName, ${AGG_COLUMNS}
         FROM usage_records u
         LEFT JOIN houses h ON h.id = u.house_id
         ${sql}
        GROUP BY u.house_id
        ORDER BY totalCost DESC, houseId ASC`,
    )
    .all(...params) as RawBreakdown[];
  return rows.map((r) => toBreakdown(r, "house"));
}

/** Totals grouped by (provider, model_id), newest split preserved. */
export function getUsageByModel(
  db: VelarisDb,
  filters: UsageFilters = {},
): UsageBreakdownDto[] {
  const { sql, params } = buildWhere(filters);
  const rows = rawDb(db)
    .prepare(
      `SELECT u.provider AS provider, u.model_id AS modelId, ${AGG_COLUMNS}
         FROM usage_records u
         ${sql}
        GROUP BY u.provider, u.model_id
        ORDER BY totalCost DESC, provider ASC, modelId ASC`,
    )
    .all(...params) as RawBreakdown[];
  return rows.map((r) => toBreakdown(r, "model"));
}

/**
 * Totals grouped by task, top-N by cost (PK join to tasks for the title).
 * `limit` bounds the response — the task breakdown is the only unbounded group
 * cardinality in a long-lived local DB.
 */
export function getUsageByTask(
  db: VelarisDb,
  filters: UsageFilters = {},
  limit = 10,
): UsageBreakdownDto[] {
  const { sql, params } = buildWhere(filters);
  const rows = rawDb(db)
    .prepare(
      `SELECT u.task_id AS taskId, t.title AS taskTitle, ${AGG_COLUMNS}
         FROM usage_records u
         LEFT JOIN tasks t ON t.id = u.task_id
         ${sql}
        GROUP BY u.task_id
        ORDER BY totalCost DESC, taskId ASC
        LIMIT ?`,
    )
    .all(...params, limit) as RawBreakdown[];
  return rows.map((r) => toBreakdown(r, "task"));
}

/**
 * Cost/token series bucketed by day (`substr(created_at,1,10)`) or hour
 * (`substr(created_at,1,13)`), oldest→newest for the sparkline. Pure
 * `usage_records` GROUP BY — no session join, so no double-count.
 */
export function getUsageTimeSeries(
  db: VelarisDb,
  bucket: "day" | "hour",
  filters: UsageFilters = {},
): UsageSeriesPointDto[] {
  const { sql, params } = buildWhere(filters);
  const width = bucket === "hour" ? 13 : 10;
  const rows = rawDb(db)
    .prepare(
      `SELECT
         substr(u.created_at, 1, ${width}) AS bucket,
         COALESCE(SUM(u.cost), 0) AS totalCost,
         COALESCE(SUM(CASE WHEN u.estimated = 1 THEN u.cost END), 0) AS estimatedCost,
         COALESCE(SUM(CASE WHEN u.estimated = 0 THEN u.cost END), 0) AS reportedCost,
         COALESCE(SUM(u.input_tokens), 0) AS inputTokens,
         COALESCE(SUM(u.output_tokens), 0) AS outputTokens
       FROM usage_records u
       ${sql}
      GROUP BY bucket
      ORDER BY bucket ASC`,
    )
    .all(...params) as Array<{
    bucket: string;
    totalCost: unknown;
    estimatedCost: unknown;
    reportedCost: unknown;
    inputTokens: unknown;
    outputTokens: unknown;
  }>;

  return rows.map((r) => ({
    bucket: r.bucket,
    totalCost: num(r.totalCost),
    estimatedCost: num(r.estimatedCost),
    reportedCost: num(r.reportedCost),
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
  }));
}
