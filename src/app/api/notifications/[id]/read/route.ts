import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  getNotification,
  setNotificationRead,
} from "@/server/repositories/execution-repo";
import { ok, notFound } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** POST /api/notifications/{id}/read → { ok, notification } */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  const notification = getNotification(getDb(), id);
  if (!notification) return notFound(`Notification not found: ${id}`);
  setNotificationRead(getDb(), id, true);
  return ok({ ok: true, notification: getNotification(getDb(), id) });
}
