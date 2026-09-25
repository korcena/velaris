import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { searchArchivesService } from "@/server/services/archive-service";
import { ok, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/archives?q=&houseId=&status=&type=&from=&to=&limit=&offset=
 *
 * Read-only searchable history over terminal tasks. `total` is the full match
 * count (not just the page) so the UI can paginate. No writer, no FTS5 (Q5).
 */
export async function GET(req: NextRequest) {
  bootstrapDb();
  try {
    const sp = req.nextUrl.searchParams;
    const result = searchArchivesService(getDb(), {
      q: sp.get("q") ?? undefined,
      houseId: sp.get("houseId") ?? undefined,
      status: sp.get("status") ?? undefined,
      type: sp.get("type") ?? undefined,
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      limit: sp.get("limit") ?? undefined,
      offset: sp.get("offset") ?? undefined,
    });
    return ok(result);
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
