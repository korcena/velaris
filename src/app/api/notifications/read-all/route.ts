import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { markAllNotificationsRead } from "@/server/repositories/execution-repo";
import { ok } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** POST /api/notifications/read-all → { ok, marked } */
export async function POST(_req: NextRequest) {
  bootstrapDb();
  const marked = markAllNotificationsRead(getDb());
  return ok({ ok: true, marked });
}
