import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  listTemplatesService,
  createTemplateService,
} from "@/server/services/template-service";
import { templateListQuerySchema } from "@/shared/schemas/template";
import { ok, created, badRequest, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/templates?kind=house|project */
export async function GET(req: NextRequest) {
  bootstrapDb();
  try {
    const parsed = templateListQuerySchema.parse({
      kind: req.nextUrl.searchParams.get("kind") ?? undefined,
    });
    return ok({ templates: listTemplatesService(getDb(), parsed.kind) });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}

/** POST /api/templates — user-created template (seeded rows cannot be created here). */
export async function POST(req: NextRequest) {
  bootstrapDb();
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const template = createTemplateService(getDb(), body);
    return created({ template });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
