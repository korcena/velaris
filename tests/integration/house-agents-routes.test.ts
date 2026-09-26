/**
 * Integration tests — agent CRUD routes (Phase 6 Stage B), invoked directly
 * with `new NextRequest()`.
 *
 * DB isolation contract (matches tests/integration/api-routes.test.ts):
 * VELARIS_DB_PATH points at a fresh temp file per test, set BEFORE importing
 * the route modules; resetDbForTests() + resetBootstrapForTests() run in
 * beforeEach.
 *
 * Coverage:
 *  - GET/POST /api/houses/{id}/agents; PATCH/DELETE .../{agentId}
 *  - 201/200/204 happy paths; 400 zod / malformed JSON; 404 unknown house/agent;
 *    409 deleting the house's only agent; 422 create/delete on the High Lord
 *    (its existing agent PATCHes → 200, and an Ollama provider → 422).
 *  - task routing honoring agent_id + cross-house rejection.
 *  - audit rows written for agent CRUD.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { resetDbForTests, getRawDb } from "@/lib/db";
import { resetBootstrapForTests } from "@/server/bootstrap";

import { POST as createHouseRoute } from "@/app/api/houses/route";
import { GET as getHouseById } from "@/app/api/houses/[id]/route";
import {
  GET as listAgents,
  POST as createAgentRoute,
} from "@/app/api/houses/[id]/agents/route";
import {
  PATCH as patchAgent,
  DELETE as deleteAgentRoute,
} from "@/app/api/houses/[id]/agents/[agentId]/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { GET as getAuditLog } from "@/app/api/audit-log/route";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-agent-routes-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(url: string, init?: RequestInit): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const method = init?.method;
  const body = init?.body;
  return new NextRequest(url, body !== undefined ? { method, body, headers } : { method, headers });
}

function jsonReq(method: string, url: string, body: unknown): NextRequest {
  return req(url, { method, body: JSON.stringify(body) });
}

function agentCtx(id: string, agentId: string) {
  return { params: Promise.resolve({ id, agentId }) };
}

function houseCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function agentPayload(name = "Cassian") {
  return {
    name,
    role: "General · commander",
    configuration: {
      systemPrompt: "You are Cassian.",
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "glm-5.3",
      workspaceAllowlist: [tmpDir],
      tools: ["fs"],
      permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  };
}

async function createHouse(): Promise<string> {
  const res = await createHouseRoute(
    jsonReq("POST", `${BASE}/api/houses`, {
      name: "House of Shadows",
      description: "",
      agent: { name: "Azriel", role: "knight" },
      configuration: agentPayload().configuration,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { house: { id: string } }).house.id;
}

async function createAgent(houseId: string, name = "Cassian"): Promise<string> {
  const res = await createAgentRoute(
    jsonReq("POST", `${BASE}/api/houses/${houseId}/agents`, agentPayload(name)),
    houseCtx(houseId),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { agent: { id: string } }).agent.id;
}

/* ================================================================== */
/* Agent CRUD routes                                                  */
/* ================================================================== */

describe("agent CRUD routes", () => {
  it("POST creates an agent → 201 with body shape; GET lists it", async () => {
    const houseId = await createHouse();
    const agentId = await createAgent(houseId);

    const listed = await listAgents(req(`${BASE}/api/houses/${houseId}/agents`), houseCtx(houseId));
    expect(listed.status).toBe(200);
    const { agents } = (await listed.json()) as { agents: Array<{ id: string; configuration: unknown }> };
    expect(agents.map((a) => a.id)).toContain(agentId);
    // Oldest-first: the default agent is index 0.
    expect(agents[0].id).not.toBe(agentId);

    const detail = await getHouseById(req(`${BASE}/api/houses/${houseId}`), houseCtx(houseId));
    const { house } = (await detail.json()) as { house: { agents: Array<{ id: string }> } };
    expect(house.agents).toHaveLength(2);
  });

  it("GET agents returns 404 for an unknown house", async () => {
    const missing = randomUUID();
    const res = await listAgents(req(`${BASE}/api/houses/${missing}/agents`), houseCtx(missing));
    expect(res.status).toBe(404);
  });

  it("POST rejects an invalid body with 400 and malformed JSON with 400", async () => {
    const houseId = await createHouse();
    const invalid = await createAgentRoute(
      jsonReq("POST", `${BASE}/api/houses/${houseId}/agents`, { name: "" }),
      houseCtx(houseId),
    );
    expect(invalid.status).toBe(400);

    const malformed = await createAgentRoute(
      new NextRequest(`${BASE}/api/houses/${houseId}/agents`, {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
      houseCtx(houseId),
    );
    expect(malformed.status).toBe(400);
  });

  it("POST rejects a smuggled houseId/status key via .strict() → 400", async () => {
    const houseId = await createHouse();
    const res = await createAgentRoute(
      jsonReq("POST", `${BASE}/api/houses/${houseId}/agents`, {
        ...agentPayload(),
        houseId: randomUUID(),
      }),
      houseCtx(houseId),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH updates name/role/config → 200; unknown agent → 404", async () => {
    const houseId = await createHouse();
    const agentId = await createAgent(houseId);
    const res = await patchAgent(
      jsonReq("PATCH", `${BASE}/api/houses/${houseId}/agents/${agentId}`, {
        role: "Commander",
        configuration: { modelId: "new-model" },
      }),
      agentCtx(houseId, agentId),
    );
    expect(res.status).toBe(200);
    const { agent } = (await res.json()) as {
      agent: { role: string; configuration: { modelId: string; systemPrompt: string } };
    };
    expect(agent.role).toBe("Commander");
    expect(agent.configuration.modelId).toBe("new-model");
    expect(agent.configuration.systemPrompt).toBe("You are Cassian."); // preserved

    const missing = randomUUID();
    const gone = await patchAgent(
      jsonReq("PATCH", `${BASE}/api/houses/${houseId}/agents/${missing}`, { role: "X" }),
      agentCtx(houseId, missing),
    );
    expect(gone.status).toBe(404);
  });

  it("DELETE refuses the house's only agent with 409", async () => {
    const houseId = await createHouse();
    const detail = await getHouseById(req(`${BASE}/api/houses/${houseId}`), houseCtx(houseId));
    const { house } = (await detail.json()) as { house: { agents: Array<{ id: string }> } };
    const onlyId = house.agents[0].id;

    const res = await deleteAgentRoute(
      req(`${BASE}/api/houses/${houseId}/agents/${onlyId}`, { method: "DELETE" }),
      agentCtx(houseId, onlyId),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/last agent/i);
  });

  it("DELETE removes a non-last agent → 204; unknown → 404", async () => {
    const houseId = await createHouse();
    const agentId = await createAgent(houseId);
    const res = await deleteAgentRoute(
      req(`${BASE}/api/houses/${houseId}/agents/${agentId}`, { method: "DELETE" }),
      agentCtx(houseId, agentId),
    );
    expect(res.status).toBe(204);

    const again = await deleteAgentRoute(
      req(`${BASE}/api/houses/${houseId}/agents/${agentId}`, { method: "DELETE" }),
      agentCtx(houseId, agentId),
    );
    expect(again.status).toBe(404);
  });

  it("rejects agent mutation when the agent belongs to a DIFFERENT house → 404", async () => {
    const houseA = await createHouse();
    const houseB = await createHouse();
    const agentA = await createAgent(houseA);

    const res = await patchAgent(
      jsonReq("PATCH", `${BASE}/api/houses/${houseB}/agents/${agentA}`, { role: "X" }),
      agentCtx(houseB, agentA),
    );
    expect(res.status).toBe(404);
  });
});

/* ================================================================== */
/* High Lord guard                                                    */
/* ================================================================== */

describe("agent CRUD on the High Lord house", () => {
  async function seedHighLord(): Promise<{ hlId: string; agentId: string }> {
    // Bootstrapping via a house route seeds the High Lord.
    await createHouse();
    const hlRow = getRawDb()
      .prepare("SELECT id FROM houses WHERE kind = 'high_lord' LIMIT 1")
      .get() as { id: string } | undefined;
    expect(hlRow).toBeTruthy();
    const hlId = hlRow!.id;
    const agentRow = getRawDb()
      .prepare("SELECT id FROM agents WHERE house_id = ? LIMIT 1")
      .get(hlId) as { id: string };
    return { hlId, agentId: agentRow.id };
  }

  it("allows PATCHing the existing agent's model/name → 200 and persists", async () => {
    const { hlId, agentId } = await seedHighLord();

    const patched = await patchAgent(
      jsonReq("PATCH", `${BASE}/api/houses/${hlId}/agents/${agentId}`, {
        name: "High Lord",
        configuration: { modelId: "highlord-model" },
      }),
      agentCtx(hlId, agentId),
    );
    expect(patched.status).toBe(200);

    const detail = await getHouseById(req(`${BASE}/api/houses/${hlId}`), houseCtx(hlId));
    expect(detail.status).toBe(200);
    const { house } = (await detail.json()) as {
      house: {
        agents: Array<{ id: string; name: string; configuration: { modelId: string } }>;
      };
    };
    const hlAgent = house.agents.find((a) => a.id === agentId)!;
    expect(hlAgent.name).toBe("High Lord");
    expect(hlAgent.configuration.modelId).toBe("highlord-model");
  });

  it("rejects create/delete and an Ollama execution provider with 422", async () => {
    const { hlId, agentId } = await seedHighLord();

    const created = await createAgentRoute(
      jsonReq("POST", `${BASE}/api/houses/${hlId}/agents`, agentPayload("Intruder")),
      houseCtx(hlId),
    );
    expect(created.status).toBe(422);

    const deleted = await deleteAgentRoute(
      req(`${BASE}/api/houses/${hlId}/agents/${agentId}`, { method: "DELETE" }),
      agentCtx(hlId, agentId),
    );
    expect(deleted.status).toBe(422);

    const ollama = await patchAgent(
      jsonReq("PATCH", `${BASE}/api/houses/${hlId}/agents/${agentId}`, {
        configuration: { executionProvider: "ollama" },
      }),
      agentCtx(hlId, agentId),
    );
    expect(ollama.status).toBe(422);
    expect(((await ollama.json()) as { error: string }).error).toMatch(
      /planning session requires OpenCode/i,
    );
  });
});

/* ================================================================== */
/* Task routing                                                       */
/* ================================================================== */

describe("task agent targeting", () => {
  it("POST /api/tasks accepts an agentId belonging to the house → 201 with agentId", async () => {
    const houseId = await createHouse();
    const agentId = await createAgent(houseId);

    const res = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, {
        title: "Targeted quest",
        houseId,
        agentId,
      }),
    );
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: { agentId: string | null } };
    expect(task.agentId).toBe(agentId);
  });

  it("POST /api/tasks defaults agentId to null (single-agent path)", async () => {
    const houseId = await createHouse();
    const res = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "Default quest", houseId }),
    );
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: { agentId: string | null } };
    expect(task.agentId).toBeNull();
  });

  it("POST /api/tasks rejects an agentId from another house with 400", async () => {
    const houseA = await createHouse();
    const houseB = await createHouse();
    const agentA = await createAgent(houseA);

    const res = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "T", houseId: houseB, agentId: agentA }),
    );
    expect(res.status).toBe(400);
  });

  it("POST /api/tasks rejects an agentId with no houseId with 400 (unroutable)", async () => {
    const houseA = await createHouse();
    const agentA = await createAgent(houseA);
    const res = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "T", agentId: agentA }),
    );
    expect(res.status).toBe(400);
  });
});

/* ================================================================== */
/* Audit writes (Q9)                                                  */
/* ================================================================== */

describe("agent CRUD audit rows", () => {
  it("create/update/delete each write an `agent` audit entry", async () => {
    const houseId = await createHouse();
    const agentId = await createAgent(houseId);
    await patchAgent(
      jsonReq("PATCH", `${BASE}/api/houses/${houseId}/agents/${agentId}`, { name: "Renamed" }),
      agentCtx(houseId, agentId),
    );
    await deleteAgentRoute(
      req(`${BASE}/api/houses/${houseId}/agents/${agentId}`, { method: "DELETE" }),
      agentCtx(houseId, agentId),
    );

    const res = await getAuditLog(req(`${BASE}/api/audit-log?entityType=agent`));
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: Array<{ action: string; entityId: string }> };
    const actions = entries.map((e) => e.action).sort();
    expect(actions).toEqual(["create", "delete", "update"]);
    expect(entries.every((e) => e.entityId === agentId)).toBe(true);
  });
});
