/**
 * Archive repository (Phase 6 Stage D) — read-only searchable history over
 * terminal tasks.
 *
 * Q5 decision: `LIKE` + indexes over existing tables for 6.1. No new table, no
 * FTS5, no writer — the engine's single-writer discipline is untouched. The
 * FTS5 external-content index is documented as the 6.2 upgrade if text volume
 * outgrows `LIKE`.
 *
 * Text matches task `title`/`description` plus artifact/agent-message content
 * for the task's sessions. `q` is escaped so `%`, `_` and the escape character
 * itself are treated literally (a user searching "100%" must not match
 * everything).
 */

import type Database from "better-sqlite3";
import type { VelarisDb } from "@/lib/db";
import { rawDb } from "@/lib/db";
import type { ArchiveEntryDto, ArchiveQuery, TaskStatus } from "@/shared/types";

/** Terminal task statuses; anything still running/queued is not archived. */
const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "interrupted"] as const;

/**
 * Escape `LIKE` wildcards. SQLite's `LIKE` treats `%` (any sequence) and `_`
 * (any single char) specially; the escape character itself must be escaped
 * first. Paired with `ESCAPE '\'` in every LIKE clause.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** First non-empty line of a string, trimmed and length-capped for the UI. */
function snippet(text: string | null | undefined, max = 200): string {
  if (!text) return "";
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface ArchiveRow {
  taskId: string;
  title: string;
  status: string;
  type: string;
  houseId: string | null;
  houseName: string | null;
  sessionCount: number;
  cost: number;
  description: string;
  resultContent: string | null;
  createdAt: string;
}

function rowToDto(row: ArchiveRow): ArchiveEntryDto {
  return {
    taskId: row.taskId,
    title: row.title,
    status: row.status as TaskStatus,
    type: row.type,
    houseId: row.houseId,
    houseName: row.houseName,
    sessionCount: row.sessionCount,
    cost: row.cost,
    summarySnippet: snippet(row.resultContent) || snippet(row.description),
    createdAt: row.createdAt,
  };
}

/** Build the shared WHERE clause + bound params for both the page and count. */
function buildWhere(query: ArchiveQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [
    `t.status IN (${TERMINAL_STATUSES.map(() => "?").join(",")})`,
  ];
  const params: unknown[] = [...TERMINAL_STATUSES];

  if (query.status) {
    clauses.push("t.status = ?");
    params.push(query.status);
  }
  if (query.houseId) {
    clauses.push("t.house_id = ?");
    params.push(query.houseId);
  }
  if (query.type) {
    clauses.push("t.type = ?");
    params.push(query.type);
  }
  if (query.from) {
    clauses.push("t.created_at >= ?");
    params.push(query.from);
  }
  if (query.to) {
    clauses.push("t.created_at <= ?");
    params.push(query.to);
  }
  if (query.q) {
    const like = `%${escapeLike(query.q)}%`;
    clauses.push(
      `(t.title LIKE ? ESCAPE '\\'
        OR t.description LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM artifacts a
           WHERE a.task_id = t.id AND a.content LIKE ? ESCAPE '\\'
        )
        OR EXISTS (
          SELECT 1 FROM agent_messages am
            JOIN execution_sessions s2 ON s2.id = am.session_id
           WHERE s2.task_id = t.id AND am.content LIKE ? ESCAPE '\\'
        ))`,
    );
    params.push(like, like, like, like);
  }

  return { sql: clauses.join(" AND "), params };
}

/**
 * Search terminal tasks newest-first with optional text/house/status/type/date
 * filters and pagination. Returns `{ entries, total }` where `total` is the
 * count of ALL matching rows (not just the page) so the UI can page.
 */
export function searchArchives(
  db: VelarisDb,
  query: ArchiveQuery,
): { entries: ArchiveEntryDto[]; total: number } {
  const raw: Database.Database = rawDb(db);
  const where = buildWhere(query);

  const countRow = raw
    .prepare(`SELECT COUNT(*) AS c FROM tasks t WHERE ${where.sql}`)
    .get(...where.params) as { c: number };

  const rows = raw
    .prepare(
      `SELECT
         t.id AS taskId,
         t.title AS title,
         t.status AS status,
         t.type AS type,
         t.house_id AS houseId,
         h.name AS houseName,
         (SELECT COUNT(*) FROM execution_sessions s WHERE s.task_id = t.id) AS sessionCount,
         COALESCE((SELECT SUM(u.cost) FROM usage_records u WHERE u.task_id = t.id), 0) AS cost,
         t.description AS description,
         (SELECT a.content FROM artifacts a
           WHERE a.task_id = t.id AND a.kind = 'result'
           ORDER BY a.created_at DESC LIMIT 1) AS resultContent,
         t.created_at AS createdAt
       FROM tasks t
       LEFT JOIN houses h ON h.id = t.house_id
      WHERE ${where.sql}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ? OFFSET ?`,
    )
    .all(...where.params, query.limit, query.offset) as ArchiveRow[];

  return {
    entries: rows.map(rowToDto),
    total: countRow.c,
  };
}
