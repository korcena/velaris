/**
 * Unit tests — monitoring helpers/service (Phase 6 Stage F).
 *
 * Proves queue-depth / running counts, 24h error/failure rates, heartbeat age
 * and liveness derivation, the engine-never-ran shape (`offline`, null age),
 * and that an unreachable provider probe degrades to false rather than
 * throwing. All reads over seeded rows; temp DB per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { countTasksByStatus } from "@/server/repositories/task-repo";
import {
  countEventsByTypeSince,
  getEngineStateKey,
} from "@/server/repositories/execution-repo";
import {
  buildMonitoring,
  deriveEngineHealth,
  heartbeatAgeMs,
} from "@/server/services/monitoring-service";

let tmpDir: string;

function seed(): void {
  const raw = getRawDb();
  raw
    .prepare(
      "INSERT INTO houses (id,name,description,kind,status) VALUES ('m-house','Monitor','','agent','active')",
    )
    .run();

  const insertTask = raw.prepare(
    `INSERT INTO tasks (id, title, description, type, status, house_id, created_at, updated_at)
     VALUES (?, ?, '', 'general', ?, 'm-house', ?, ?)`,
  );
  const now = "2026-03-01T12:00:00.000Z";
  insertTask.run("m-q1", "Queued 1", "queued", now, now);
  insertTask.run("m-q2", "Queued 2", "queued", now, now);
  insertTask.run("m-q3", "Queued 3", "queued", now, now);
  insertTask.run("m-r1", "Running 1", "running", now, now);
  insertTask.run("m-c1", "Done 1", "completed", now, now);

  const insertSession = raw.prepare(
    `INSERT INTO execution_sessions (id, task_id, house_id, status, provider, model_id, created_at, updated_at)
     VALUES (?, ?, 'm-house', 'completed', 'opencode', 'glm-5.3', ?, ?)`,
  );
  insertSession.run("m-s1", "m-c1", now, now);

  const insertEvent = raw.prepare(
    `INSERT INTO execution_events (session_id, task_id, house_id, raw_type, type, payload, created_at)
     VALUES ('m-s1', 'm-c1', 'm-house', ?, ?, '{}', ?)`,
  );
  // Inside the 24h window (relative to the injected now below).
  insertEvent.run("error", "error", "2026-03-01T11:00:00.000Z");
  insertEvent.run("task_failed", "task_failed", "2026-03-01T10:00:00.000Z");
  insertEvent.run("task_failed", "task_failed", "2026-03-01T09:00:00.000Z");
  insertEvent.run("task_completed", "task_completed", "2026-03-01T08:00:00.000Z");
  insertEvent.run("message", "message", "2026-03-01T07:00:00.000Z");
  // Outside the 24h window — must not be counted.
  insertEvent.run("error", "error", "2026-02-20T00:00:00.000Z");
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-monitoring-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  migrate();
  seed();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = new Date("2026-03-01T12:00:30.000Z");

describe("queue depth + running count", () => {
  it("counts tasks by status", () => {
    expect(countTasksByStatus(getDb(), "queued")).toBe(3);
    expect(countTasksByStatus(getDb(), "running")).toBe(1);
    expect(countTasksByStatus(getDb(), "completed")).toBe(1);
    expect(countTasksByStatus(getDb(), "failed")).toBe(0);
  });
});

describe("error/failure rates from execution_events", () => {
  it("counts only events inside the since window", () => {
    const since = "2026-03-01T00:00:00.000Z";
    expect(countEventsByTypeSince(getDb(), ["error"], since)).toBe(1);
    expect(countEventsByTypeSince(getDb(), ["task_failed"], since)).toBe(2);
    expect(countEventsByTypeSince(getDb(), ["error", "task_failed"], since)).toBe(3);
    expect(countEventsByTypeSince(getDb(), [], since)).toBe(0);
  });

  it("excludes events older than the window", () => {
    const since = "2026-03-01T00:00:00.000Z";
    const allErrors = countEventsByTypeSince(getDb(), ["error"], "2026-01-01T00:00:00.000Z");
    expect(allErrors).toBe(2); // includes the 2026-02-20 row
  });
});

describe("engine_state reads + liveness", () => {
  it("returns null for absent keys", () => {
    expect(getEngineStateKey(getDb(), "engine_heartbeat_at")).toBeNull();
    expect(getEngineStateKey(getDb(), "engine_version")).toBeNull();
  });

  it("reads a persisted key", () => {
    getRawDb()
      .prepare(
        "INSERT INTO engine_state (key, value, updated_at) VALUES ('engine_heartbeat_at', '2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')",
      )
      .run();
    expect(getEngineStateKey(getDb(), "engine_heartbeat_at")).toBe("2026-03-01T12:00:00.000Z");
  });

  it("deriveEngineHealth maps age to online/stale/offline", () => {
    expect(deriveEngineHealth(null)).toBe("offline");
    expect(deriveEngineHealth(0)).toBe("online");
    expect(deriveEngineHealth(15_000)).toBe("online");
    expect(deriveEngineHealth(15_001)).toBe("stale");
    expect(deriveEngineHealth(120_000)).toBe("stale");
  });

  it("heartbeatAgeMs handles missing/invalid timestamps", () => {
    expect(heartbeatAgeMs(null, NOW.getTime())).toBeNull();
    expect(heartbeatAgeMs("not-a-date", NOW.getTime())).toBeNull();
    expect(heartbeatAgeMs("2026-03-01T12:00:00.000Z", NOW.getTime())).toBe(30_000);
  });
});

describe("buildMonitoring", () => {
  it("engine never ran ⇒ offline with null age and a zeroed queue", async () => {
    const m = await buildMonitoring(getDb(), { now: NOW });
    expect(m.engineHeartbeatAt).toBeNull();
    expect(m.heartbeatAgeMs).toBeNull();
    expect(m.engineHealth).toBe("offline");
    expect(m.engineVersion).toBeNull();
    expect(m.providerHealth).toBe(false);
    expect(m.queueDepth).toBe(3);
    expect(m.runningCount).toBe(1);
    expect(m.errorsLast24h).toBe(1);
    expect(m.failuresLast24h).toBe(2);
    expect(m.eventsLast24h).toBe(5); // the 5 in-window events
    expect(m.checkedAt).toBe(NOW.toISOString());
  });

  it("fresh heartbeat ⇒ online and surfaces version/pid", async () => {
    const raw = getRawDb();
    const t = "2026-03-01T12:00:20.000Z";
    raw
      .prepare("INSERT INTO engine_state (key, value, updated_at) VALUES ('engine_heartbeat_at', ?, ?)")
      .run(t, t);
    raw
      .prepare("INSERT INTO engine_state (key, value, updated_at) VALUES ('engine_version', '0.2.0-engine', ?)")
      .run(t);
    raw
      .prepare("INSERT INTO engine_state (key, value, updated_at) VALUES ('opencode_server_pid', '4242', ?)")
      .run(t);

    const m = await buildMonitoring(getDb(), { now: NOW });
    expect(m.engineHealth).toBe("online");
    expect(m.heartbeatAgeMs).toBe(10_000);
    expect(m.engineVersion).toBe("0.2.0-engine");
    expect(m.opencodeServerPid).toBe("4242");
  });

  it("stale heartbeat ⇒ stale", async () => {
    const t = "2026-03-01T11:59:00.000Z"; // 90s before NOW
    getRawDb()
      .prepare("INSERT INTO engine_state (key, value, updated_at) VALUES ('engine_heartbeat_at', ?, ?)")
      .run(t, t);
    const m = await buildMonitoring(getDb(), { now: NOW });
    expect(m.engineHealth).toBe("stale");
    expect(m.heartbeatAgeMs).toBe(90_000);
  });

  it("tolerates a throwing provider probe (unreachable ⇒ false)", async () => {
    const m = await buildMonitoring(getDb(), {
      now: NOW,
      probeProviderHealth: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(m.providerHealth).toBe(false);
  });

  it("reports providerHealth true when the probe resolves true", async () => {
    const m = await buildMonitoring(getDb(), {
      now: NOW,
      probeProviderHealth: async () => true,
    });
    expect(m.providerHealth).toBe(true);
  });
});
