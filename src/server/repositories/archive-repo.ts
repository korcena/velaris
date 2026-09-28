/**
 * Archive repository (Phase 6 Stage D) — read-only searchable history over
 * terminal tasks.
 *
 * Q5 decision: `LIKE` + indexes over existing tables is the semantic floor and
 * remains the default/fallback. Phase 6.2 Stage S2 adds an additive FTS5 index
 * (`archives_fts`, migrations 0010 + 0011) over task title/description and
 * artifact text. When the index exists it is used **automatically and
 * ADDITIVELY** for the text `q` filter: the FTS branch is OR'd with the original
 * 4-way `LIKE` branch, never substituted for it. That matters because FTS
 * phrase-quoting matches whole tokens (no prefix/substring, and tokens can be
 * split across fields), so an FTS-only `q` would silently NARROW the public
 * "search titles, descriptions, results…" behaviour. With the OR, every `LIKE`
 * hit still matches and FTS only widens recall.
 *
 * Messages are NOT indexed in FTS (migration 0011 removed the O(history)
 * `group_concat` triggers — see 0011): they are covered by the `LIKE` floor,
 * which is always present. There is still no repository writer — the engine's
 * single-writer discipline is untouched.
 *
 * `q` is escaped so `%`, `_` and the escape character itself are treated
 * literally (a user searching "100%" must not match everything).
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

/**
 * True when the additive FTS5 archive index (migration 0010) is present. The
 * index is optional: an older DB that has not run 0010 silently uses the
 * `LIKE` fallback, so this must never throw when the table is absent.
 */
export function hasArchiveFts(raw: Database.Database): boolean {
  const row = raw
    .prepare(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='archives_fts') AS e",
    )
    .get() as { e: number } | undefined;
  return row?.e === 1;
}

/**
 * Turn arbitrary user text into a safe FTS5 `MATCH` expression.
 *
 * Every whitespace-delimited token is wrapped in double quotes (FTS5 phrase
 * quoting) with embedded `"` doubled, so FTS operators (`*`, `-`, `OR`, `NEAR`,
 * `(`, `)`, `^`, `:`) and wildcards are all treated as literal token text and a
 * `MATCH` built from this can never raise a syntax error. Multiple quoted
 * tokens are an implicit AND, matching the old `LIKE` behaviour for normal
 * multi-word searches. Returns "" for blank input (the caller then skips FTS).
 */
export function sanitizeFtsQuery(input: string): string {
  return input
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
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
  deletedAt: string | null;
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
    deletedAt: row.deletedAt,
  };
}

/** Build the shared WHERE clause + bound params for both the page and count. */
function buildWhere(query: ArchiveQuery, raw: Database.Database): { sql: string; params: unknown[] } {
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
    // The ORIGINAL `LIKE` branch is ALWAYS included for `q`: it is the semantic
    // floor (substring/prefix semantics the UI promises). FTS, when present, is
    // OR'd in ADDITIVELY to widen recall — it is never substituted for LIKE,
    // because FTS phrase-quoting matches whole tokens only and would silently
    // drop `Ques`/`uest`-style and cross-field matches that LIKE finds.
    const like = `%${escapeLike(query.q)}%`;
    const likeClause = `(t.title LIKE ? ESCAPE '\\'
          OR t.description LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM artifacts a
             WHERE a.task_id = t.id AND a.content LIKE ? ESCAPE '\\'
          )
          OR EXISTS (
            SELECT 1 FROM agent_messages am
              JOIN execution_sessions s2 ON s2.id = am.session_id
             WHERE s2.task_id = t.id AND am.content LIKE ? ESCAPE '\\'
          ))`;

    // Automatic-if-present: widen with the additive FTS index when it exists.
    // Queries containing `%`, `_` or `\` skip the FTS branch (the `unicode61`
    // tokenizer treats those as separators and cannot reproduce LIKE's literal
    // wildcard semantics, e.g. a literal "50%"); the LIKE branch still runs, so
    // these are never lost.
    const fts = hasArchiveFts(raw) && !/[\\%_]/.test(query.q) ? sanitizeFtsQuery(query.q) : "";
    if (fts) {
      clauses.push(
        `((${likeClause}) OR EXISTS (SELECT 1 FROM archives_fts f WHERE f.task_id = t.id AND archives_fts MATCH ?))`,
      );
      params.push(like, like, like, like, fts);
    } else {
      // LIKE-only path (index absent or FTS tokenisation would lose punctuation).
      clauses.push(likeClause);
      params.push(like, like, like, like);
    }
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
  const where = buildWhere(query, raw);

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
         t.created_at AS createdAt,
         t.deleted_at AS deletedAt
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
