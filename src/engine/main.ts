/**
 * Velaris Engine — Phase 1 stub.
 *
 * Phase 1 scope (per IMPLEMENTATION_PLAN §5.2): runs DB migrations, writes a
 * heartbeat every few seconds, handles graceful shutdown. It does NOT execute
 * tasks.
 *
 * Phase 2+ adds: task queue loop, OpenCode adapter (SSE ingestion), approval
 * request relay, session persistence. The engine is the primary writer for
 * execution-state tables.
 */

import { migrate } from "@/lib/db/migrate";
import { getRawDb } from "@/lib/db";
import { seedDefaultProviderConfigs } from "@/server/repositories/provider-config-repo";

const HEARTBEAT_INTERVAL_MS = 10_000; // log cadence
const HEARTBEAT_WRITE_MS = 5_000; // row upsert cadence

const ENGINE_HEARTBEAT_KEY = "engine_heartbeat_at";
const ENGINE_VERSION_KEY = "engine_version";

function nowIso(): string {
  return new Date().toISOString();
}

function writeHeartbeat(db: ReturnType<typeof getRawDb>): void {
  const heartbeatAt = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO engine_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(ENGINE_HEARTBEAT_KEY, heartbeatAt, heartbeatAt);

    db.prepare(
      `INSERT INTO engine_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(ENGINE_VERSION_KEY, "0.1.0-stub", nowIso());
  });
  tx();
}

async function main(): Promise<void> {
  // 1. Bring the schema up to date (idempotent).
  migrate();

  const db = getRawDb();
  // 2. Seed the two default provider configs if absent (idempotent).
  const seeded = seedDefaultProviderConfigs(db);

  // 3. Heartbeat row so /api/health can report engine liveness.
  writeHeartbeat(db);

  console.log(`[velaris-engine] migrations applied; seeded ${seeded} default provider config(s)`);
  console.log("[velaris-engine] Velaris engine alive (Phase 1 stub — no execution)");

  const logTimer = setInterval(() => {
    console.log(`[velaris-engine] heartbeat ${nowIso()}`);
  }, HEARTBEAT_INTERVAL_MS);

  const writeTimer = setInterval(() => {
    try {
      writeHeartbeat(db);
    } catch (err) {
      console.error("[velaris-engine] heartbeat write failed:", err);
    }
  }, HEARTBEAT_WRITE_MS);

  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[velaris-engine] received ${signal}, shutting down cleanly…`);
    clearInterval(logTimer);
    clearInterval(writeTimer);
    try {
      db.close();
    } catch {
      /* noop */
    }
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
