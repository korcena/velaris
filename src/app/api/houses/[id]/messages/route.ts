import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { getHouseService, HouseNotFoundError } from "@/server/services/house-service";
import { houseMessageSchema } from "@/shared/schemas/notification";
import {
  getActiveSessionForHouse,
  createAgentMessage,
  listAgentMessagesForSession,
} from "@/server/repositories/execution-repo";
import { ok, notFound, badRequest, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/houses/{id}/messages { content }
 *
 * Sends a follow-up message to the house's ACTIVE session. The engine's task
 * runner polls pending user messages and relays them to the provider via
 * `sendMessage`. We insert a row the engine picks up (agent_messages role=user)
 * and return "accepted" immediately — the web process never runs execution.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  const house = getHouseService(getDb(), id);
  if (!house) return notFound(`House not found: ${id}`);

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const parsed = houseMessageSchema.parse(body);
    const session = getActiveSessionForHouse(getDb(), id);
    if (!session) {
      return notFound("This house has no active execution session to message");
    }
    // Persist the user message for the engine to relay.
    createAgentMessage(getDb(), { sessionId: session.id, role: "user", content: parsed.content });
    return ok({ accepted: true, sessionId: session.id });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}

/**
 * GET /api/houses/{id}/messages — recent agent chat (user + agent messages) for
 * the house's most recent session.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  const house = getHouseService(getDb(), id);
  if (!house) return notFound(`House not found: ${id}`);
  const session = getActiveSessionForHouse(getDb(), id);
  if (!session) return ok({ messages: [] });
  const messages = listAgentMessagesForSession(getDb(), session.id);
  return ok({ messages });
}
