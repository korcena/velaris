import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { findHighLordHouse } from "@/server/repositories/house-repo";
import { createTask } from "@/server/repositories/task-repo";
import {
  getProject,
  assertValidDirectory,
  ProjectNotFoundError,
  listProjects,
} from "@/server/repositories/project-repo";
import { courtInstructionSchema } from "@/shared/schemas/plan";
import { created, notFound, badRequest, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/court/instructions { instruction, projectId?, workingDirectory?, priority? }
 *
 * Creates a parent task on the High Lord house from the Court composer. The
 * engine picks it up like any queued task (routed to the orchestrator because
 * the house is kind='high_lord').
 *
 * The planner session requires a real directory, resolved (in priority order):
 *  1. an explicit `workingDirectory` (validated absolute + existing),
 *  2. `projectId`'s directory,
 *  3. the first project's directory (fallback so the text-only composer works),
 *  4. the High Lord house's first configured allowlist entry.
 * If none resolve, the request is a 400.
 */
export async function POST(req: NextRequest) {
  bootstrapDb();
  try {
    const hl = findHighLordHouse(getDb());
    if (!hl) return notFound("High Lord house not seeded");

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const parsed = courtInstructionSchema.parse(body);

    // Resolve the planning/child working directory.
    let workingDirectory: string | null = null;
    if (parsed.workingDirectory) {
      try {
        assertValidDirectory(parsed.workingDirectory);
      } catch {
        return badRequest(
          "workingDirectory must be an existing absolute directory",
          { field: "workingDirectory" },
        );
      }
      workingDirectory = parsed.workingDirectory;
    } else {
      // projectId explicit → its directory.
      let project = parsed.projectId ? getProject(getDb(), parsed.projectId) : null;
      if (parsed.projectId && !project) {
        throw new ProjectNotFoundError(parsed.projectId);
      }
      // Fallback: the first registered project (composer sends text only, D5).
      if (!project) {
        project = listProjects(getDb())[0] ?? null;
      }
      // Last resort: the High Lord's first allowlist entry.
      if (!project) {
        const allowlist = hl.configuration.workspaceAllowlist;
        if (allowlist.length > 0) {
          workingDirectory = allowlist[0];
        }
      } else {
        workingDirectory = project.directory;
      }
      if (!workingDirectory) {
        return badRequest(
          "A working directory (or a project whose directory is used) is required",
          { field: "workingDirectory" },
        );
      }
    }

    const title = parsed.instruction.slice(0, 80);
    const parent = createTask(getDb(), {
      title: title.trim() || "Court instruction",
      description: parsed.instruction,
      houseId: hl.id,
      projectId: parsed.projectId ?? null,
      workingDirectory,
      priority: parsed.priority,
      executionPreferences: {},
    });
    return created({ task: parent });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
