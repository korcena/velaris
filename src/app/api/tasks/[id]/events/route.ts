import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { listEventsForTask } from "@/server/repositories/execution-repo";
import { getTask } from "@/server/repositories/task-repo";
import { taskEventsQuerySchema } from "@/shared/schemas/execution";
import { ok, notFound } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/{id}/events?afterId= → { events }
 * Activity feed for a task (execution_events, ordered by engine id).
 * `events` are already ordered by engine id (the cursor field `id`) — the
 * client can paginate by passing the last seen `id` as `afterId`.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  bootstrapDb();
  const { id } = await ctx.params;
  const task = getTask(getDb(), id);
  if (!task) return notFound(`Task not found: ${id}`);

  const { afterId } = taskEventsQuerySchema.parse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  const events = listEventsForTask(getDb(), id, afterId);
  return ok({ events });
}
