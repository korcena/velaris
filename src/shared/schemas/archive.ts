/**
 * Zod schemas for the read-only archive search API (Phase 6 Stage D).
 *
 * `archiveQuerySchema` is the single validation source for
 * `GET /api/archives`. Query params arrive as strings, so numeric coercion
 * happens here. Pagination follows Q6: default 25, hard cap 100, and the
 * response exposes `total` so the UI can page through the full history.
 *
 * Search is a `LIKE` scan over existing tables (no new table, no FTS5 — Q5);
 * the 6.2 upgrade path is an external-content FTS5 index (documented, not
 * built).
 */

import { z } from "zod";

/** Terminal task statuses eligible for the archive view. */
export const ARCHIVE_STATUSES = ["completed", "failed", "cancelled", "interrupted"] as const;

/** Default page size for archive search (Q6). */
export const ARCHIVE_DEFAULT_LIMIT = 25;
/** Hard cap on a single page (Q6). */
export const ARCHIVE_MAX_LIMIT = 100;

/** GET /api/archives?q=&houseId=&status=&type=&from=&to=&limit=&offset= */
export const archiveQuerySchema = z.object({
  q: z.string().trim().max(500).optional(),
  houseId: z.string().trim().min(1).max(200).optional(),
  status: z.enum(ARCHIVE_STATUSES).optional(),
  type: z.string().trim().min(1).max(120).optional(),
  /** ISO timestamps; compared lexically against the ISO text column. */
  from: z.string().trim().min(1).max(40).optional(),
  to: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(ARCHIVE_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type ArchiveQueryInput = z.infer<typeof archiveQuerySchema>;
