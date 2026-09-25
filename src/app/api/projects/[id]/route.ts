import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  getProject,
  updateProject,
  deleteProject,
  ProjectNotFoundError,
  ProjectHasTasksError,
  ProjectDirectoryExistsError,
  ProjectDirectoryInvalidError,
} from "@/server/repositories/project-repo";
import { projectUpdateSchema } from "@/shared/schemas/project";
import { recordAudit } from "@/server/repositories/audit-repo";
import {
  ok,
  noContent,
  notFound,
  conflict,
  badRequest,
  routeErrorOrMapped,
} from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/projects/{id} */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  const project = getProject(getDb(), id);
  if (!project) return notFound(`Project not found: ${id}`);
  return ok({ project });
}

/** PATCH /api/projects/{id} */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const parsed = projectUpdateSchema.parse(body);
    const project = updateProject(getDb(), id, {
      name: parsed.name,
      description: parsed.description,
      directory: parsed.directory,
      defaultModel: parsed.defaultModel,
      instructions: parsed.instructions,
    });
    recordAudit(getDb(), {
      actor: "user",
      action: "update",
      entityType: "project",
      entityId: project.id,
      metadata: { changed: Object.keys(parsed) },
    });
    return ok({ project });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return notFound(err.message);
    if (err instanceof ProjectDirectoryExistsError) return conflict(err.message);
    if (err instanceof ProjectDirectoryInvalidError) return badRequest(err.message);
    return routeErrorOrMapped(err);
  }
}

/** DELETE /api/projects/{id} — blocked if a task references it. */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    const existing = getProject(getDb(), id);
    deleteProject(getDb(), id);
    recordAudit(getDb(), {
      actor: "user",
      action: "delete",
      entityType: "project",
      entityId: id,
      metadata: { name: existing?.name ?? null },
    });
    return noContent();
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return notFound(err.message);
    if (err instanceof ProjectHasTasksError) return conflict(err.message);
    return routeErrorOrMapped(err);
  }
}
