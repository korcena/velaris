import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  getProviderConfig,
  updateProviderConfig,
  deleteProviderConfig,
  ProviderConfigNotFoundError,
} from "@/server/repositories/provider-config-repo";
import { providerConfigUpdateSchema } from "@/shared/schemas/provider-config";
import { ok, noContent, notFound, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/provider-configs/{id} */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  const config = getProviderConfig(getDb(), id);
  if (!config) return notFound(`Provider config not found: ${id}`);
  return ok({ providerConfig: config });
}

/** PATCH /api/provider-configs/{id} */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    const body = await req.json();
    const parsed = providerConfigUpdateSchema.parse(body);
    const config = updateProviderConfig(getDb(), id, {
      name: parsed.name,
      type: parsed.type,
      baseUrl: parsed.baseUrl,
      isDefault: parsed.isDefault,
      extra: parsed.extra,
    });
    return ok({ providerConfig: config });
  } catch (err) {
    if (err instanceof ProviderConfigNotFoundError) return notFound(err.message);
    return routeErrorOrMapped(err);
  }
}

/** DELETE /api/provider-configs/{id} */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  bootstrapDb();
  const { id } = await ctx.params;
  try {
    deleteProviderConfig(getDb(), id);
    return noContent();
  } catch (err) {
    if (err instanceof ProviderConfigNotFoundError) return notFound(err.message);
    return routeErrorOrMapped(err);
  }
}
