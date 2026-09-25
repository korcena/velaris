import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import { OpencodeClient } from "@/server/opencode";
import { buildMonitoring } from "@/server/services/monitoring-service";
import { ok, routeErrorOrMapped } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * Bound the best-effort OpenCode probe so an unresponsive server cannot hang the
 * whole dashboard request. Scoped to this client instance only — no change to
 * the shared client's behaviour for other callers. `health()` swallows the
 * abort and degrades to `false`.
 */
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

/**
 * GET /api/monitoring
 *
 * Read-only engine health / queue depth / error-rate snapshot for the root
 * dashboard panel. Sources: `engine_state`, `tasks`, `execution_events` plus a
 * best-effort web-side OpenCode health probe (consistent with `/api/models`).
 * `providerHealth` degrades to false when the server is unreachable so the
 * engine-off e2e environment still gets a 200.
 */
export async function GET(_req: NextRequest) {
  bootstrapDb();
  try {
    const client = new OpencodeClient({ signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    const result = await buildMonitoring(getDb(), {
      probeProviderHealth: () => client.health(),
    });
    return ok(result);
  } catch (err) {
    return routeErrorOrMapped(err);
  }
}
