import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { findHighLordHouse } from "@/server/repositories/house-repo";
import { buildCourtHistory } from "@/server/services/plan-service";
import { ok, notFound } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/court/history → { messages, highLordHouseId }
 *
 * The Court chat log across recent High Lord parent tasks, plus the seeded
 * High Lord house id (additive envelope field) so the Court can deep-link
 * "Configure the High Lord" to /houses/{highLordHouseId}.
 */
export async function GET(_req: NextRequest) {
  bootstrapDb();
  const hl = findHighLordHouse(getDb());
  if (!hl) return notFound("High Lord house not seeded");

  const messages = buildCourtHistory(getDb(), hl.id, 20);
  return ok({ messages, highLordHouseId: hl.id });
}
