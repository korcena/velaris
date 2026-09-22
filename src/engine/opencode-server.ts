/**
 * OpenCode server lifecycle manager (ARCHITECTURE §8).
 *
 * Ensures an `opencode serve --port <p>` process is healthy:
 *  1. Probe GET /api/health on the configured base URL.
 *  2. If healthy → adopt the existing server (even user-started). Never kill it.
 *  3. If not healthy → spawn a detached child, wait for health (poll), then use it.
 * On shutdown the engine kills the process ONLY if the engine spawned it.
 *
 * Pid tracking (bug 4): when the engine spawns a server it writes the child pid
 * + started_at to `engine_state` (opencode_server_pid / opencode_server_started_at),
 * and clears them on stop, so /api/health can surface the engine-owned server.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type Database from "better-sqlite3";
import { resolveBaseUrl, OpencodeClient } from "@/server/opencode";
import { DEFAULT_OPENCODE_PORT } from "@/shared/constants";

const OSC_PID_KEY = "opencode_server_pid";
const OSC_STARTED_KEY = "opencode_server_started_at";

export interface ServerManagerDeps {
  client: OpencodeClient;
  /** Raw better-sqlite3 handle for engine_state pid tracking. */
  db?: Database.Database;
  log: (msg: string) => void;
}

export class OpenCodeServerManager {
  private client: OpencodeClient;
  private db: Database.Database | null;
  private log: (msg: string) => void;
  private child: ChildProcess | null = null;
  private spawnedByUs = false;
  private shuttingDown = false;

  constructor(deps: ServerManagerDeps) {
    this.client = deps.client;
    this.db = deps.db ?? null;
    this.log = deps.log;
  }

  get isSpawnedByUs(): boolean {
    return this.spawnedByUs;
  }

  private baseUrlPort(): number {
    const baseUrl = resolveBaseUrl();
    try {
      const u = new URL(baseUrl);
      return Number(u.port) || DEFAULT_OPENCODE_PORT;
    } catch {
      return DEFAULT_OPENCODE_PORT;
    }
  }

  /**
   * Ensure a healthy OpenCode server is available. Returns true if healthy.
   * Throws if unable to start after retries (engine should surface as offline).
   */
  async ensureHealthy(opts: {
    timeoutMs?: number;
    retryDelayMs?: number;
    maxSpawnRetries?: number;
  } = {}): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const retryDelayMs = opts.retryDelayMs ?? 500;
    const maxSpawnRetries = opts.maxSpawnRetries ?? 2;

    if (await this.client.health()) {
      this.spawnedByUs = false;
      return true;
    }

    // Try to spawn it (retrying a few times in case the binary is slow to boot).
    for (let attempt = 0; attempt <= maxSpawnRetries; attempt++) {
      this.spawn();
      const deadline = Date.now() + timeoutMs;
      let becameHealthy = false;
      while (Date.now() < deadline) {
        if (await this.client.health()) {
          becameHealthy = true;
          break;
        }
        await sleep(retryDelayMs);
      }
      if (becameHealthy) {
        this.spawnedByUs = true;
        return true;
      }
      // Not healthy — clear the child (bug 4) so the next spawn() actually
      // spawns instead of no-oping on a stale `this.child`.
      this.clearChild("never became healthy");
      this.log(`[opencode-server] spawn attempt ${attempt + 1} did not become healthy; retrying`);
    }

    return false; // give up; engine treats OpenCode as offline
  }

  private spawn(): void {
    if (this.child) {
      this.log("[opencode-server] spawn() skipped — a child is already tracked");
      return;
    }
    const port = this.baseUrlPort();
    this.log(`[opencode-server] spawning \`opencode serve --port ${port}\` (detached)`);
    try {
      const child = spawn("opencode", ["serve", "--port", String(port)], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      // Bug 4: an async 'error' event (e.g. binary missing) does NOT throw, so
      // without handling it `this.child` stays set and retries no-op. Clear the
      // child on error so ensureHealthy() actually retries.
      child.on("error", (err) => {
        this.log(`[opencode-server] spawn error: ${err.message}`);
        // Only clear if this child is still the one we track.
        if (this.child === child) {
          this.spawnedByUs = false;
          this.clearStateKey();
        }
      });
      child.unref(); // do not keep the engine's event loop alive just for this
      this.child = child;
      this.spawnedByUs = true;
      this.writeStateKey(child.pid ?? null);
    } catch (err) {
      this.log(`[opencode-server] spawn threw: ${err instanceof Error ? err.message : String(err)}`);
      this.child = null;
      this.spawnedByUs = false;
      this.clearStateKey();
    }
  }

  /** Clear the tracked child (after spawn error / exit-before-healthy) so retries work. */
  private clearChild(reason: string): void {
    this.log(`[opencode-server] clearing child (${reason})`);
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
    }
    this.child = null;
    this.spawnedByUs = false;
    this.clearStateKey();
  }

  /** Write the engine-owned child pid + started_at to engine_state (bug 4). */
  private writeStateKey(pid: number | null): void {
    if (!this.db) return;
    const nowIso = new Date().toISOString();
    try {
      const upsert = this.db.prepare(
        `INSERT INTO engine_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      upsert.run(OSC_PID_KEY, pid !== null ? String(pid) : "", nowIso);
      upsert.run(OSC_STARTED_KEY, nowIso, nowIso);
    } catch {
      /* engine_state is best-effort */
    }
  }

  /** Clear the engine-owned server keys from engine_state. */
  private clearStateKey(): void {
    if (!this.db) return;
    try {
      this.db.prepare("DELETE FROM engine_state WHERE key = ?").run(OSC_PID_KEY);
      this.db.prepare("DELETE FROM engine_state WHERE key = ?").run(OSC_STARTED_KEY);
    } catch {
      /* best-effort */
    }
  }

  /** Kill the child ONLY if the engine spawned it. */
  killIfOwned(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.child && this.spawnedByUs) {
      this.log("[opencode-server] killing OpenCode server we spawned (graceful shutdown)");
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
      this.child = null;
      this.spawnedByUs = false;
      this.clearStateKey();
    } else if (this.child) {
      this.log("[opencode-server] not killing OpenCode (we adopted an existing server)");
      this.child = null;
      this.spawnedByUs = false;
    } else {
      // No child tracked; just ensure no stale engine_state pid row lingers.
      this.clearStateKey();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
