import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { listApprovalRequests } from "@/server/repositories/execution-repo";
import { ok } from "@/server/api-helpers";
import type { ApprovalStatus } from "@/shared/types";

export const dynamic = "force-dynamic";

const VALID_STATUSES: ApprovalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "replied",
  "cancelled",
];

/** GET /api/approvals?status=pending — list approval requests. */
export async function GET(req: NextRequest) {
  bootstrapDb();
  const statusRaw = req.nextUrl.searchParams.get("status");
  const status = VALID_STATUSES.includes(statusRaw as ApprovalStatus)
    ? (statusRaw as ApprovalStatus)
    : undefined;
  const approvals = listApprovalRequests(getDb(), { status });
  return ok({ approvals });
}
