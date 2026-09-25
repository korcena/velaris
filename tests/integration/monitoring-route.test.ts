/**
 * Integration tests — monitoring route (Phase 6 Stage F), invoked directly with
 * `new NextRequest()`.
 *
 * DB isolation contract: VELARIS_DB_PATH to a fresh temp file BEFORE importing
 * the route modules; resetDbForTests() + resetBootstrapForTests() in beforeEach.
 *
 * The OpenCode probe is pointed at an unreachable URL so the shape assertion is
 * deterministic (no live server needed, mirroring the engine-off e2e). A second
 * case seeds `engine_state` + queued/error rows and asserts the metrics.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { resetDbForTests, getRawDb } from "@/lib/db";
import { resetBootstrapForTests, bootstrapDb } from "@/server/bootstrap";
import { GET as getMonitoring } from "@/app/api/monitoring/route";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-monitoring-routes-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  // Deterministic provider-unreachable probe.
  process.env.OPENCODE_BASE_URL = "http://127.0.0.1:1";
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  delete process.env.OPENCODE_BASE_URL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(url: string): NextRequest {
  return new NextRequest(url, { headers: { "content-type": "application/json" } });
}

describe("GET /api/monitoring", () => {
  it("returns the empty/offline shape when the engine has never run", async () => {
    bootstrapDb();
    const res = await getMonitoring(req(`${BASE}/api/monitoring`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.engineHeartbeatAt).toBeNull();
    expect(body.heartbeatAgeMs).toBeNull();
    expect(body.engineHealth).toBe("offline");
    expect(body.queueDepth).toBe(0);
    expect(body.runningCount).toBe(0);
    expect(body.errorsLast24h).toBe(0);
    expect(body.failuresLast24h).toBe(0);
    expect(body.providerHealth).toBe(false);
    expect(typeof body.checkedAt).toBe("string");
  });

  it("reflects seeded heartbeat + queue + error rows", async () => {
    bootstrapDb();
    const raw = getRawDb();
    raw
      .prepare("INSERT INTO houses (id,name,description,kind,status) VALUES ('mr-house','Monitor','','agent','active')")
      .run();
    const now = new Date().toISOString();
    const insertTask = raw.prepare(
      `INSERT INTO tasks (id,title,description,type,status,house_id,created_at,updated_at) VALUES (?,?,'','general',?,'mr-house',?,?)`,
    );
    insertTask.run("mr-q1", "Queued", "queued", now, now);
    insertTask.run("mr-q2", "Queued 2", "queued", now, now);
    insertTask.run("mr-r1", "Running", "running", now, now);

    raw
      .prepare("INSERT INTO execution_sessions (id,task_id,house_id,status,provider,model_id,created_at,updated_at) VALUES ('mr-s1','mr-q1','mr-house','completed','opencode','glm-5.3',?,?)")
      .run(now, now);
    raw
      .prepare("INSERT INTO execution_events (session_id,task_id,house_id,raw_type,type,payload,created_at) VALUES ('mr-s1','mr-q1','mr-house','error','error','{}',?)")
      .run(now);
    raw
      .prepare("INSERT INTO execution_events (session_id,task_id,house_id,raw_type,type,payload,created_at) VALUES ('mr-s1','mr-q1','mr-house','task_failed','task_failed','{}',?)")
      .run(now);
    // Fresh heartbeat (engine running).
    raw
      .prepare("INSERT INTO engine_state (key,value,updated_at) VALUES ('engine_heartbeat_at',?,?)")
      .run(now, now);
    raw
      .prepare("INSERT INTO engine_state (key,value,updated_at) VALUES ('engine_version','9.9.9-test',?)")
      .run(now);

    const res = await getMonitoring(req(`${BASE}/api/monitoring`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.engineHealth).toBe("online");
    expect(body.engineVersion).toBe("9.9.9-test");
    expect(body.queueDepth).toBe(2);
    expect(body.runningCount).toBe(1);
    expect(body.errorsLast24h).toBe(1);
    expect(body.failuresLast24h).toBe(1);
    expect(body.eventsLast24h).toBe(2);
    expect(body.providerHealth).toBe(false); // unreachable by construction
  });
});
