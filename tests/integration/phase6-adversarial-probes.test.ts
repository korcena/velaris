/**
 * ADVERSARIAL Phase 6.1 probes — audit idempotency + monitoring coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { resetDbForTests, getDb, getRawDb } from "@/lib/db";
import { resetBootstrapForTests } from "@/server/bootstrap";
import { POST as createHouseRoute } from "@/app/api/houses/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { POST as respondApproval } from "@/app/api/approvals/[id]/respond/route";
import {
  createExecutionSession,
  createApprovalRequest,
  countEventsByTypeSince,
} from "@/server/repositories/execution-repo";
import { buildMonitoring } from "@/server/services/monitoring-service";
import { EXECUTION_EVENT_TYPES } from "@/shared/constants";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-adv-probe-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
});
afterEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function jsonReq(method: string, url: string, body: unknown) {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

const config = {
  systemPrompt: "You are an agent.",
  executionProvider: "opencode",
  aiProvider: "ollama-cloud",
  modelId: "glm-5.3",
  workspaceAllowlist: [] as string[],
  tools: ["fs"],
  permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
  approvalPolicy: "always",
  concurrency: 1,
};

async function setupApproval(): Promise<string> {
  const house = (await (
    await createHouseRoute(
      jsonReq("POST", `${BASE}/api/houses`, {
        name: "Audit Probe House",
        agent: { name: "A", role: "R" },
        configuration: config,
      }),
    )
  ).json()) as { house: { id: string } };
  const task = (await (
    await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "Quest", houseId: house.house.id }),
    )
  ).json()) as { task: { id: string } };
  const db = getDb();
  const session = createExecutionSession(db, {
    taskId: task.task.id,
    houseId: house.house.id,
    provider: "opencode",
    modelId: "glm-5.3",
    directory: tmpDir,
  });
  const approval = createApprovalRequest(db, {
    sessionId: session.id,
    taskId: task.task.id,
    houseId: house.house.id,
    providerRequestId: `pr-${Date.now()}`,
    kind: "permission",
    title: "T",
    message: "M",
  })!;
  return approval.id;
}

describe("ADVERSARIAL: approval re-respond audit idempotency", () => {
  it("a second respond on an already-resolved approval still writes another audit row (no-op recorded)", async () => {
    const id = await setupApproval();
    const first = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${id}/respond`, { action: "approve" }),
      idCtx(id),
    );
    expect(first.status).toBe(200);

    // The approval is no longer pending; setApprovalResponse is a no-op here.
    const second = await respondApproval(
      jsonReq("POST", `${BASE}/api/approvals/${id}/respond`, { action: "reject" }),
      idCtx(id),
    );
    expect(second.status).toBe(200);

    const auditRows = getRawDb()
      .prepare(
        "SELECT COUNT(*) c FROM audit_log WHERE entity_type='approval' AND entity_id=?",
      )
      .get(id) as { c: number };
    // Observation: the route audits EVERY call, including the second no-op.
    expect(auditRows.c).toBe(2);
  });
});

describe("ADVERSARIAL: monitoring event coverage", () => {
  it("eventsLast24h equals the sum over the canonical EXECUTION_EVENT_TYPES list", async () => {
    // Bootstrap/migrate via a route.
    await createHouseRoute(
      jsonReq("POST", `${BASE}/api/houses`, { name: "M House", agent: { name: "A", role: "R" }, configuration: config }),
    );
    const raw = getRawDb();
    const now = new Date().toISOString();
    const ins = raw.prepare(
      "INSERT INTO execution_events (session_id,task_id,house_id,raw_type,type,payload,created_at) VALUES (NULL,NULL,NULL,?,?, '{}', ?)",
    );
    for (const t of EXECUTION_EVENT_TYPES) ins.run(t, t, now);

    const sum = countEventsByTypeSince(getDb(), [...EXECUTION_EVENT_TYPES], new Date(Date.now() - 1000).toISOString());
    const m = await buildMonitoring(getDb(), { now: new Date() });
    expect(m.eventsLast24h).toBe(sum);
    expect(m.eventsLast24h).toBe(EXECUTION_EVENT_TYPES.length);
  });
});
