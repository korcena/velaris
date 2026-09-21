import { NextRequest, NextResponse } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  createProject,
  listProjects,
  ProjectDirectoryExistsError,
  ProjectDirectoryInvalidError,
} from "@/server/repositories/project-repo";
import { projectCreateSchema } from "@/shared/schemas/project";
import { created, ok, conflict, badRequest, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/projects */
export async function GET() {
  bootstrapDb();
  return ok({ projects: listProjects(getDb()) });
}

/** POST /api/projects */
export async function POST(req: NextRequest) {
  bootstrapDb();
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const parsed = projectCreateSchema.parse(body);
    const project = createProject(getDb(), {
      name: parsed.name,
      description: parsed.description ?? "",
      directory: parsed.directory,
      defaultModel: parsed.defaultModel,
      instructions: parsed.instructions,
    });
    return created({ project });
  } catch (err) {
    if (err instanceof ProjectDirectoryExistsError) return conflict(err.message);
    if (err instanceof ProjectDirectoryInvalidError) return badRequest(err.message);
    return routeErrorOrMapped(err);
  }
}
