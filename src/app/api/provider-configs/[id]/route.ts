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
import { recordAudit } from "@/server/repositories/audit-repo";
import { ok, noContent, notFound, badRequest, routeErrorOrMapped } from "@/server/api-helpers";

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
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("Request body must be valid JSON");
    }
    const parsed = providerConfigUpdateSchema.parse(body);
    const config = updateProviderConfig(getDb(), id, {
      name: parsed.name,
      type: parsed.type,
      baseUrl: parsed.baseUrl,
      isDefault: parsed.isDefault,
      extra: parsed.extra,
    });
    recordAudit(getDb(), {
      actor: "user",
      action: "update",
      entityType: "provider_config",
      entityId: config.id,
      metadata: { changed: Object.keys(parsed) },
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
    const existing = getProviderConfig(getDb(), id);
    deleteProviderConfig(getDb(), id);
    recordAudit(getDb(), {
      actor: "user",
      action: "delete",
      entityType: "provider_config",
      entityId: id,
      metadata: { name: existing?.name ?? null, type: existing?.type ?? null },
    });
    return noContent();
  } catch (err) {
    if (err instanceof ProviderConfigNotFoundError) return notFound(err.message);
    return routeErrorOrMapped(err);
  }
}
