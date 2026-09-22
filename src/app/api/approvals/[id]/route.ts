import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { getApprovalById } from "@/server/repositories/execution-repo";
import { ok, notFound } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/approvals/{id} — single approval request. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  const approval = getApprovalById(getDb(), id);
  if (!approval) return notFound(`Approval request not found: ${id}`);
  return ok({ approval });
}
