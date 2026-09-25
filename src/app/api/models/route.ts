import { NextRequest } from "next/server";
import { OpencodeClient } from "@/server/opencode";
import { OllamaClient, resolveOllamaBaseUrl } from "@/server/execution/ollama/client";
import { listModels } from "@/server/services/model-service";
import { ok } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/models — model picker backing.
 *
 * Proxies the requested provider's model endpoint server-side:
 *  - `?providerId=opencode` (default): OpenCode GET /api/model.
 *  - `?providerId=ollama`: Ollama GET /api/tags (decision Q8).
 * Returns `{ models: [...], available: bool }`. When the server is unreachable
 * it returns a graceful `{ models: [], available: false }` (200) so the UI can
 * render a free-text fallback instead of erroring — house creation works with NO
 * server running.
 */
export async function GET(req: NextRequest) {
  const providerId = req.nextUrl.searchParams.get("providerId");
  const client = new OpencodeClient();
  const ollamaClient = providerId === "ollama" ? new OllamaClient({ baseUrl: resolveOllamaBaseUrl() }) : null;
  const result = await listModels(client, providerId, ollamaClient);
  return ok(result);
}
