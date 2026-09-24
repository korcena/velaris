/**
 * Velaris Engine — entry point (Phase 2).
 *
 * Boot order (lifecycle matters):
 *  1. Migrate DB (same idempotent mechanism as the web bootstrap).
 *  2. Seed default provider configs.
 *  3. Reconcile — requeue orphaned in-flight tasks so an engine-restart
 *     recovers state BEFORE the queue starts polling (recovered tasks must be
 *     claimable).
 *  4. Start the OpenCode server lifecycle manager — probe GET /api/health on the
 *     configured port, adopt an existing server or spawn `opencode serve`.
 *  5. Start the task queue loop. The queue health-gates task execution on the
 *     OpenCode server being healthy, so it can start polling immediately while
 *     the server manager is still bringing the server up.
 *  6. Heartbeat + graceful shutdown (SIGINT/SIGTERM): stop the queue, kill the
 *     OpenCode server ONLY if the engine owns it, then close DB.
 *
 * The engine is the SINGLE WRITER of execution_sessions / execution_events /
 * approval_requests transitions / notifications. Web only reads execution state.
 */

import { migrate } from "@/lib/db/migrate";
import { closeDb, getRawDb, getDb } from "@/lib/db";
import { seedDefaultProviderConfigs } from "@/server/repositories/provider-config-repo";
import { seedHighLordHouse } from "@/server/repositories/house-repo";
import { OpencodeClient } from "@/server/opencode";
import { createOpenCodeAdapter } from "@/server/execution/opencode/provider";
import { OpenCodeServerManager } from "./opencode-server";
import { reconcile } from "./reconcile";
import { TaskQueue } from "./queue";

const HEARTBEAT_INTERVAL_MS = 10_000; // log cadence
const HEARTBEAT_WRITE_MS = 5_000; // row upsert cadence
const SERVER_CONNECT_TIMEOUT_MS = 60_000;

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
    ).run(ENGINE_VERSION_KEY, "0.2.0-engine", nowIso());
  });
  tx();
}

const log = (msg: string): void => console.log(msg);

async function main(): Promise<void> {
  // 1. Bring the schema up to date (idempotent — same as web bootstrap).
  console.log("[velaris-engine] applying migrations…");
  migrate();

  const raw = getRawDb();
  // 2. Seed the two default provider configs if absent (idempotent).
  const seeded = seedDefaultProviderConfigs(raw);
  // Seed the singleton High Lord house (idempotent; never clobbers user edits).
  seedHighLordHouse(raw);
  const db = getDb();

  // 3. Heartbeat row so /api/health can report engine liveness.
  writeHeartbeat(raw);

  console.log(`[velaris-engine] migrations applied; seeded ${seeded} default provider config(s)`);

  // 4. Reconcile BEFORE the queue starts polling — recovered tasks must be
  //    claimable on the first tick (§12 recovery).
  const client = new OpencodeClient({ signal: undefined });
  console.log("[velaris-engine] reconciling orphaned execution state…");
  await reconcile(db, raw, client, log);

  // 5. OpenCode server lifecycle manager (probe → adopt → spawn).
  const server = new OpenCodeServerManager({ client, db: raw, log });
  const healthy = await server.ensureHealthy({ timeoutMs: SERVER_CONNECT_TIMEOUT_MS });
  if (healthy) {
    log("[velaris-engine] OpenCode server healthy (adopted or spawned)");
  } else {
    log("[velaris-engine] WARNING: OpenCode server NOT healthy — tasks will stay queued until it is reachable");
  }

  // 6. Task queue loop. The queue health-gates execution, so it is safe to start
  //    polling immediately even when the server is still coming up.
  const abortController = new AbortController();
  const queue = new TaskQueue({
    db,
    raw,
    adapter: createOpenCodeAdapter({ client, db }),
    client,
    signal: abortController.signal,
    log,
  });
  await queue.start();
  log("[velaris-engine] Velaris engine alive (Phase 2 — queue + OpenCode lifecycle active)");

  const logTimer = setInterval(() => {
    log(`[velaris-engine] heartbeat ${nowIso()}`);
  }, HEARTBEAT_INTERVAL_MS);

  const writeTimer = setInterval(() => {
    try {
      writeHeartbeat(raw);
    } catch (err) {
      console.error("[velaris-engine] heartbeat write failed:", err);
    }
  }, HEARTBEAT_WRITE_MS);

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[velaris-engine] received ${signal}, shutting down cleanly…`);

    // a. Stop the poll loop + abort in-flight.
    abortController.abort();
    try {
      await queue.stop();
    } catch (err) {
      console.error("[velaris-engine] queue stop error:", err);
    }

    // b. Kill the OpenCode server ONLY if the engine owns it.
    server.killIfOwned();

    clearInterval(logTimer);
    clearInterval(writeTimer);

    // c. Close DB.
    try {
      closeDb();
    } catch {
      /* noop */
    }

    log("[velaris-engine] shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
