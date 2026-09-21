import { NextRequest, NextResponse } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  createHouseService,
  listHousesService,
} from "@/server/services/house-service";
import { created, ok, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/houses?includeArchived=false */
export async function GET(req: NextRequest) {
  bootstrapDb();
  const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "true";
  const houses = listHousesService(getDb(), includeArchived);
  return ok({ houses });
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
