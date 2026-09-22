import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { approvalRespondSchema } from "@/shared/schemas/approval";
import {
  getApprovalById,
  setApprovalResponse,
  markNotificationsReadForApproval,
} from "@/server/repositories/execution-repo";
import { ok, notFound, badRequest, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/approvals/{id}/respond { action, response?, optionId? }
 *
 * THE WEB'S ONLY EXECUTION-ADJACENT WRITE. Updates the approval_requests row's
 * status (approved/rejected/replied) + response text and marks the linked
 * notification read. The ENGINE (task runner polling loop) notices the
 * responded row and relays the action to OpenCode asynchronously.
 *
 *  - approve: status → approved
 *  - reject:  status → rejected (+ optional message)
 *  - reply:   status → replied (requires `response`)
 *  - select:  status → replied with the option's label as the response
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const parsed = approvalRespondSchema.parse(body);

    const approval = getApprovalById(getDb(), id);
    if (!approval) return notFound(`Approval request not found: ${id}`);

    let nextStatus: "approved" | "rejected" | "replied";
    let responseText: string | null = null;

    switch (parsed.action) {
      case "approve":
        nextStatus = "approved";
        break;
      case "reject":
        nextStatus = "rejected";
        responseText = parsed.response ?? null;
        break;
      case "select": {
        nextStatus = "replied";
        // Resolve the chosen option label.
        const option = approval.options.find((o) => o.id === parsed.optionId);
        responseText = option?.label ?? parsed.response ?? parsed.optionId ?? "";
        break;
      }
      case "reply":
      default:
        if (!parsed.response) {
          return badRequest("A reply action requires `response` text");
        }
        nextStatus = "replied";
        responseText = parsed.response;
        break;
    }

    const updated = setApprovalResponse(getDb(), id, nextStatus, responseText);
    if (!updated) return notFound(`Approval request not found: ${id}`);

    // Bug 10: mark the linked bird notification(s) read now that the user acted.
    // The web process owns notification read state; `approvalRequestId` links the
    // notification to the approval, so we mark by that key.
    markNotificationsReadForApproval(getDb(), updated.id);

    return ok({ approval: updated });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
