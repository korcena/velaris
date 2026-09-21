import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  listProviderConfigs,
  createProviderConfig,
} from "@/server/repositories/provider-config-repo";
import { providerConfigCreateSchema } from "@/shared/schemas/provider-config";
import { created, ok, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/provider-configs */
export async function GET() {
  bootstrapDb();
  return ok({ providerConfigs: listProviderConfigs(getDb()) });
}

/** POST /api/provider-configs */
export async function POST(req: NextRequest) {
  bootstrapDb();
  try {
    const body = await req.json();
    const parsed = providerConfigCreateSchema.parse(body);
    const config = createProviderConfig(getDb(), {
      name: parsed.name,
      type: parsed.type,
      baseUrl: parsed.baseUrl,
      isDefault: parsed.isDefault,
      extra: parsed.extra,
    });
    return created({ providerConfig: config });
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
