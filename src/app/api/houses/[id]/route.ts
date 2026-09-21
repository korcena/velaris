import { NextRequest, NextResponse } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  getHouseService,
  updateHouseService,
  transitionHouseStatusService,
  deleteHouseService,
  HouseNotFoundError,
} from "@/server/services/house-service";
import { houseStatusTransitionSchema } from "@/shared/schemas/house";
import {
  ok,
  created,
  noContent,
  notFound,
  badRequest,
  conflict,
  badTransition,
  routeErrorOrMapped,
} from "@/server/api-helpers";
import { HouseNotArchivedError, InvalidStatusTransitionError } from "@/server/repositories/house-repo";

export const dynamic = "force-dynamic";

/** GET /api/houses/{id} */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  const house = getHouseService(getDb(), id);
  if (!house) return notFound(`House not found: ${id}`);
  return ok({ house });
}

/** PATCH /api/houses/{id} — update fields and/or transition status. */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    const body = await req.json();

    // Detect a status transition payload (explicit status move).
    const statusProbe = houseStatusTransitionSchema.safeParse(body);
    if (statusProbe.success) {
      const house = transitionHouseStatusService(getDb(), id, statusProbe.data.status);
      return ok({ house });
    }

    // Otherwise treat as a field update (zod will 400 on unknown fields).
    const house = updateHouseService(getDb(), id, body);
    return ok({ house });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}

/** DELETE /api/houses/{id} — only when archived. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    deleteHouseService(getDb(), id);
    return noContent();
  } catch (err) {
    if (err instanceof HouseNotFoundError) return notFound(err.message);
    if (err instanceof HouseNotArchivedError) return conflict(err.message);
    if (err instanceof InvalidStatusTransitionError) return badTransition(err.message);
    return routeErrorOrMapped(err);
  }
}
