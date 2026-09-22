import { NextRequest } from "next/server";
import { OpencodeClient } from "@/server/opencode";
import { listModels } from "@/server/services/model-service";
import { ok } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/models — model picker backing.
 *
 * Proxies OpenCode's `GET /api/model` (server-side via the engine client) and
 * returns `{ models: [...], available: bool }`. When the OpenCode server is
 * unreachable it returns a graceful `{ models: [], available: false }` (200)
 * so the UI can render a text fallback instead of erroring.
 *
 * Optional `?providerId=` filter trims the list to a single provider.
 * Results are cached in-memory for ~30s (see model-service).
 */
export async function GET(req: NextRequest) {
  const client = new OpencodeClient();
  const providerId = req.nextUrl.searchParams.get("providerId");
  const result = await listModels(client, providerId);
  return ok(result);
}
