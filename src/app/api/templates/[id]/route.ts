import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  getTemplateService,
  updateTemplateService,
  deleteTemplateService,
} from "@/server/services/template-service";
import { notFound, ok, noContent, badRequest, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/templates/{id} */
export async function GET(req: NextRequest, ctx: Ctx) {
  bootstrapDb();
  const { id } = await ctx.params;
  const template = getTemplateService(getDb(), id);
  if (!template) return notFound(`Template not found: ${id}`);
  return ok({ template });
}

/** PATCH /api/templates/{id} — seeded templates are immutable (409). */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const template = updateTemplateService(getDb(), id, body);
    return ok({ template });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}

/** DELETE /api/templates/{id} — seeded templates are immutable (409). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    deleteTemplateService(getDb(), id);
    return noContent();
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
