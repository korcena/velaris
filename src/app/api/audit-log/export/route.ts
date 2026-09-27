import { NextRequest, NextResponse } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { listAuditLog, toAuditCsv } from "@/server/repositories/audit-repo";
import {
  auditExportQuerySchema,
  AUDIT_EXPORT_DEFAULT_LIMIT,
} from "@/shared/schemas/audit";
import { ok, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/audit-log/export?format=csv|json&actor=&entityType=&entityId=
 *     &action=&from=&to=&limit=
 *
 * Read-only export over the append-only audit trail. Web writes nothing here;
 * the engine owns the periodic retention prune (Phase 6.2 Stage S4 — Q4).
 *
 * - `csv` (default): RFC-4180 text (CRLF rows, quote iff `,`/`"`/CR/LF) with a
 *   `Content-Disposition` attachment filename.
 * - `json`: `{ entries: AuditLogDto[] }`.
 */
export async function GET(req: NextRequest) {
  bootstrapDb();
  try {
    const params = req.nextUrl.searchParams;
    const parsed = auditExportQuerySchema.parse({
      format: params.get("format") ?? undefined,
      limit: params.get("limit") ?? undefined,
      actor: params.get("actor") ?? undefined,
      entityType: params.get("entityType") ?? undefined,
      entityId: params.get("entityId") ?? undefined,
      action: params.get("action") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
    });
    const limit = Math.min(parsed.limit ?? AUDIT_EXPORT_DEFAULT_LIMIT, AUDIT_EXPORT_DEFAULT_LIMIT);
    const entries = listAuditLog(getDb(), {
      limit,
      actor: parsed.actor,
      entityType: parsed.entityType,
      entityId: parsed.entityId,
      action: parsed.action,
      from: parsed.from,
      to: parsed.to,
    });

    if (parsed.format === "json") {
      return ok({ entries });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new NextResponse(toAuditCsv(entries), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-log-${timestamp}.csv"`,
      },
    });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
