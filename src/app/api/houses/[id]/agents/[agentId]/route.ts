import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  updateAgentService,
  deleteAgentService,
  AgentNotFoundError,
} from "@/server/services/house-service";
import { ok, noContent, notFound, badRequest, conflict, routeErrorOrMapped } from "@/server/api-helpers";
import { LastAgentError } from "@/server/repositories/house-repo";

export const dynamic = "force-dynamic";

/** PATCH /api/houses/{id}/agents/{agentId} — update an agent + its configuration. */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; agentId: string }> },
) {
  bootstrapDb();
  const { id, agentId } = await ctx.params;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const agent = updateAgentService(getDb(), id, agentId, body);
    return ok({ agent });
  } catch (err) {
    if (err instanceof AgentNotFoundError) return notFound(err.message);
    return routeErrorOrMapped(err);
  }
}

/** DELETE /api/houses/{id}/agents/{agentId} — refuses the house's last agent. */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; agentId: string }> },
) {
  bootstrapDb();
  const { id, agentId } = await ctx.params;
  try {
    deleteAgentService(getDb(), id, agentId);
    return noContent();
  } catch (err) {
    if (err instanceof AgentNotFoundError) return notFound(err.message);
    if (err instanceof LastAgentError) return conflict(err.message);
    return routeErrorOrMapped(err);
  }
}
