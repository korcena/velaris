import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { listTasks, createTask } from "@/server/repositories/task-repo";
import { taskCreateSchema } from "@/shared/schemas/task";
import { created, ok, badRequest, routeErrorOrMapped } from "@/server/api-helpers";
import { TASK_STATUSES } from "@/shared/constants";
import type { TaskStatus } from "@/shared/types";

export const dynamic = "force-dynamic";

/** GET /api/tasks?houseId=&projectId=&status= */
export async function GET(req: NextRequest) {
  bootstrapDb();
  const sp = req.nextUrl.searchParams;
  const houseId = sp.get("houseId") ?? undefined;
  const projectId = sp.get("projectId") ?? undefined;
  const statusRaw = sp.get("status");
  // Accept any status from the shared constant (full Phase 2 execution set).
  const status = (TASK_STATUSES as readonly string[]).includes(statusRaw ?? "")
    ? (statusRaw as TaskStatus)
    : undefined;
  const tasks = listTasks(getDb(), { houseId, projectId, status });
  return ok({ tasks });
}

/** POST /api/tasks — created rows are forced to status='queued'. */
export async function POST(req: NextRequest) {
  bootstrapDb();
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const parsed = taskCreateSchema.parse(body);
    const task = createTask(getDb(), {
      title: parsed.title,
      description: parsed.description ?? "",
      type: parsed.type,
      priority: parsed.priority,
      houseId: parsed.houseId,
      projectId: parsed.projectId,
      workingDirectory: parsed.workingDirectory,
      executionPreferences: parsed.executionPreferences,
    });
    return created({ task });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
