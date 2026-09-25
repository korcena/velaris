/**
 * Archive service (Phase 6 Stage D) — pure read. Validates the query with
 * `archiveQuerySchema` (the single API-input source), applies the Q6 pagination
 * defaults (limit 25, hard cap 100), and delegates to the read-only archive
 * repo.
 *
 * No audit writes: archives are read-only (Q9 audits web user-action rows only).
 */

import type { VelarisDb } from "@/lib/db";
import { searchArchives } from "@/server/repositories/archive-repo";
import {
  archiveQuerySchema,
  ARCHIVE_DEFAULT_LIMIT,
  ARCHIVE_MAX_LIMIT,
  type ArchiveQueryInput,
} from "@/shared/schemas/archive";
import type { ArchiveEntryDto, ArchiveQuery } from "@/shared/types";

export { ARCHIVE_DEFAULT_LIMIT, ARCHIVE_MAX_LIMIT };

export function searchArchivesService(
  db: VelarisDb,
  input: unknown,
): { entries: ArchiveEntryDto[]; total: number; limit: number; offset: number } {
  const parsed: ArchiveQueryInput = archiveQuerySchema.parse(input);
  const limit = Math.min(parsed.limit ?? ARCHIVE_DEFAULT_LIMIT, ARCHIVE_MAX_LIMIT);
  const offset = parsed.offset ?? 0;

  const query: ArchiveQuery = {
    q: parsed.q,
    houseId: parsed.houseId,
    status: parsed.status,
    type: parsed.type,
    from: parsed.from,
    to: parsed.to,
    limit,
    offset,
  };

  const { entries, total } = searchArchives(db, query);
  return { entries, total, limit, offset };
}
