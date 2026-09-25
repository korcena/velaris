import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { listAuditLog } from "@/server/repositories/audit-repo";
import {
  auditLogQuerySchema,
  AUDIT_LOG_DEFAULT_LIMIT,
  AUDIT_LOG_MAX_LIMIT,
} from "@/shared/schemas/audit";
import { ok, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/audit-log?limit=&offset=&actor=&entityType=&entityId=&action=
 *
 * Read-only paginated view of the append-only audit trail. Web user-action
 * rows only (Q9); engine execution lifecycle lives in execution_events.
 */
export async function GET(req: NextRequest) {
  bootstrapDb();
  try {
    const params = req.nextUrl.searchParams;
    const parsed = auditLogQuerySchema.parse({
      limit: params.get("limit") ?? undefined,
      offset: params.get("offset") ?? undefined,
      actor: params.get("actor") ?? undefined,
      entityType: params.get("entityType") ?? undefined,
      entityId: params.get("entityId") ?? undefined,
      action: params.get("action") ?? undefined,
    });
    const limit = Math.min(parsed.limit ?? AUDIT_LOG_DEFAULT_LIMIT, AUDIT_LOG_MAX_LIMIT);
    const entries = listAuditLog(getDb(), {
      limit,
      offset: parsed.offset,
      actor: parsed.actor,
      entityType: parsed.entityType,
      entityId: parsed.entityId,
      action: parsed.action,
    });
    return ok({ entries });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
