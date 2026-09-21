import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb, getRawDb } from "@/lib/db";
import { ok } from "@/server/api-helpers";
import type { HealthDto } from "@/shared/types";

const ENGINE_HEARTBEAT_KEY = "engine_heartbeat_at";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  // Migrate + seed on first call (idempotent across worker/process restarts).
  bootstrapDb();

  const db = getDb();
  // A cheap DB liveness check.
  db.run("SELECT 1");

  let engineHeartbeatAt: string | null = null;
  try {
    const raw = getRawDb();
    const row = raw
      .prepare("SELECT value FROM engine_state WHERE key = ?")
      .get(ENGINE_HEARTBEAT_KEY) as { value: string } | undefined;
    engineHeartbeatAt = row?.value ?? null;
  } catch {
    engineHeartbeatAt = null;
  }

  const body: HealthDto = {
    status: "ok",
    db: "ok",
    migrations: "applied",
    engineHeartbeatAt,
  };
  return ok(body);
}
