import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  getTemplateService,
  instantiateHouseTemplate,
  instantiateProjectTemplate,
} from "@/server/services/template-service";
import { templateInstantiateSchema } from "@/shared/schemas/template";
import { created, badRequest, notFound, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/templates/{id}/instantiate
 *
 * Instantiate a fully configured house or project from the template. The
 * response envelope is `{ house }` or `{ project }` depending on the template's
 * kind. A project template requires a `directory` (supplied here, validated by
 * the existing repo checks). All writes run the same schemas as normal creation.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      // An empty body is acceptable for a house instantiation; a project
      // instantiation without a directory fails below with a clear 400.
      body = {};
    }
    const overrides = templateInstantiateSchema.parse(body);

    const template = getTemplateService(getDb(), id);
    if (!template) return notFound(`Template not found: ${id}`);

    if (template.kind === "house") {
      const house = instantiateHouseTemplate(getDb(), id, {
        name: overrides.name,
        agentName: overrides.agentName,
      });
      return created({ house });
    }

    if (!overrides.directory) {
      return badRequest("A directory is required to instantiate a project template");
    }
    const project = instantiateProjectTemplate(getDb(), id, {
      name: overrides.name,
      directory: overrides.directory,
    });
    return created({ project });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
