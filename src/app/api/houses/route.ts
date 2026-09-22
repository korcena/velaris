import { NextRequest, NextResponse } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  createHouseService,
  listHousesService,
} from "@/server/services/house-service";
import { buildHouseListSummary } from "@/server/services/execution-service";
import type { HouseDto } from "@/shared/types";
import { created, ok, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/houses?includeArchived=false */
export async function GET(req: NextRequest) {
  bootstrapDb();
  const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "true";
  const houses = listHousesService(getDb(), includeArchived);
  // Enrich each house with the runtime status + pending approval count for the
  // house-card bird indicator. The envelope stays `{ houses: [...] }` and each
  // entry is the plain HouseDto plus `runtimeStatus` / `pendingApprovals`.
  const enriched = houses.map((house: HouseDto) => ({
    ...house,
    ...buildHouseListSummary(getDb(), house),
  }));
  return ok({ houses: enriched });
}

/** POST /api/houses */
export async function POST(req: NextRequest) {
  bootstrapDb();
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }
    const house = createHouseService(getDb(), body);
    return created({ house });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
