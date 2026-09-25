import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  listAgentsService,
  createAgentService,
  HouseNotFoundError,
} from "@/server/services/house-service";
import { created, ok, notFound, badRequest, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/houses/{id}/agents — list all agents under a house (oldest-first). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    const agents = listAgentsService(getDb(), id);
    if (!agents) return notFound(`House not found: ${id}`);
    return ok({ agents });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}

/** POST /api/houses/{id}/agents — create an agent + its configuration. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const agent = createAgentService(getDb(), id, body);
    return created({ agent });
  } catch (err) {
    if (err instanceof HouseNotFoundError) return notFound(err.message);
    return routeErrorOrMapped(err);
  }
}
