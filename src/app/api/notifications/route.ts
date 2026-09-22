import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  listNotifications,
  countUnreadNotifications,
} from "@/server/repositories/execution-repo";
import { ok } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications?unreadOnly=0|1 → { notifications, unread }
 */
export async function GET(req: NextRequest) {
  bootstrapDb();
  const unreadOnly = req.nextUrl.searchParams.get("unreadOnly") === "1";
  const notifications = listNotifications(getDb(), { unreadOnly });
  const unread = countUnreadNotifications(getDb());
  return ok({ notifications, unread });
}
