/**
 * ADVERSARIAL Phase 6.1 integration verification (independent QA).
 *
 * Probes:
 *  - audit write-failure isolation (must never break the primary operation);
 *  - audit GET pagination cap + filters + CHECK enforcement;
 *  - template instantiate with a tampered/invalid stored payload (no bypass);
 *  - project template directory uniqueness (409) via the existing repo check;
 *  - template update cannot swap payload kind;
 *  - monitoring degrades with an unreachable provider (engine-off e2e).
 *
 * Isolation contract: VELARIS_DB_PATH is set in beforeEach BEFORE handlers run
 * (getRawDb is lazy), with resetDbForTests()/resetBootstrapForTests().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { resetDbForTests, getRawDb } from "@/lib/db";
import { resetBootstrapForTests } from "@/server/bootstrap";

import { GET as getAuditLog } from "@/app/api/audit-log/route";
import { POST as createHouseRoute } from "@/app/api/houses/route";
import { POST as createTemplateRoute, GET as listTemplates } from "@/app/api/templates/route";
import {
  PATCH as patchTemplate,
  GET as getTemplate,
} from "@/app/api/templates/[id]/route";
import { POST as instantiateRoute } from "@/app/api/templates/[id]/instantiate/route";
import { GET as getMonitoring } from "@/app/api/monitoring/route";
import { recordAudit, listAuditLog } from "@/server/repositories/audit-repo";
import { getDb } from "@/lib/db";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-adv-int-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
});

afterEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function req(url: string, init?: RequestInit): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const body = init?.body;
  const method = init?.method;
  return new NextRequest(url, body !== undefined ? { method, body, headers } : { method, headers });
}
const jsonReq = (method: string, url: string, body: unknown) =>
  req(url, { method, body: JSON.stringify(body) });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

const housePayload = {
  description: "tpl",
  agent: { name: "Templar", role: "Knight" },
  configuration: {
    systemPrompt: "You are a templar.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: [],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  },
};
const projectPayload = { description: "p", defaultModel: "m", instructions: "i" };

/* ================================================================== */
/* Audit — failure isolation + validation                             */
/* ================================================================== */

describe("ADVERSARIAL: audit write failure isolation", () => {
  it("recordAudit swallows a DB error and returns null (never throws into the request path)", () => {
    // A db proxy whose insert().values().run() throws.
    const throwing = {
      insert: () => ({
        values: () => ({
          run: () => {
            throw new Error("disk I/O error");
          },
        }),
      }),
    } as never;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: string | null = "unset" as never;
    expect(() => {
      result = recordAudit(throwing, {
        action: "create",
        entityType: "house",
        entityId: "x",
      });
    }).not.toThrow();
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it("a bad actor is rejected by the CHECK and does not create a row", async () => {
    // Bootstrap the temp DB via a route. MUST be awaited: an un-awaited handler
    // can resume after afterEach unsets VELARIS_DB_PATH and then boot against the
    // real dev DB (test-isolation leak).
    await createHouseRoute(
      jsonReq("POST", `${BASE}/api/houses`, {
        name: "Audit Isolation House",
        agent: { name: "A", role: "R" },
        configuration: housePayload.configuration,
      }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = recordAudit(getDb(), {
      // @ts-expect-error deliberately invalid actor
      actor: "robot",
      action: "create",
      entityType: "house",
      entityId: "bad",
    });
    expect(id).toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it("audit GET caps the page: limit=101 → 400, limit=100 → 200, default → 25", async () => {
    // Seed >100 entries directly (bypassing the service) so the page is bounded.
    await createHouseRoute(
      jsonReq("POST", `${BASE}/api/houses`, {
        name: "Seed House",
        agent: { name: "A", role: "R" },
        configuration: housePayload.configuration,
      }),
    );
    const raw = getRawDb();
    const insert = raw.prepare(
      "INSERT INTO audit_log (id,actor,action,entity_type,entity_id,metadata,created_at) VALUES (?, 'user','create','house',?,'{}',?)",
    );
    for (let i = 0; i < 150; i++) {
      insert.run(randomUUID(), `e-${i}`, new Date(Date.now() + i).toISOString());
    }

    const tooBig = await getAuditLog(req(`${BASE}/api/audit-log?limit=101`));
    expect(tooBig.status).toBe(400);

    const capped = await getAuditLog(req(`${BASE}/api/audit-log?limit=100`));
    expect(capped.status).toBe(200);
    const cappedBody = (await capped.json()) as { entries: unknown[] };
    expect(cappedBody.entries).toHaveLength(100);

    const dflt = await getAuditLog(req(`${BASE}/api/audit-log`));
    const dfltBody = (await dflt.json()) as { entries: unknown[] };
    expect(dfltBody.entries).toHaveLength(25);
  });

  it("audit GET filters by entityType and actor", async () => {
    await createHouseRoute(
      jsonReq("POST", `${BASE}/api/houses`, {
        name: "Filter House",
        agent: { name: "A", role: "R" },
        configuration: housePayload.configuration,
      }),
    );
    const res = await getAuditLog(req(`${BASE}/api/audit-log?entityType=house&actor=user`));
    const body = (await res.json()) as { entries: Array<{ entityType: string; actor: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.entityType === "house" && e.actor === "user")).toBe(true);
  });
});

/* ================================================================== */
/* Templates — tamper + no-bypass                                     */
/* ================================================================== */

describe("ADVERSARIAL: template payload validation cannot be bypassed", () => {
  async function createTpl(kind: "house" | "project", payload: unknown, name = `T-${Date.now()}-${Math.random()}`) {
    const res = await createTemplateRoute(
      jsonReq("POST", `${BASE}/api/templates`, { kind, name, payload }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { template: { id: string } }).template.id;
  }

  it("a tampered invalid JSON payload stored directly in the DB → instantiate 400 (no bypass)", async () => {
    const id = await createTpl("house", housePayload);
    // Tamper the stored payload to an invalid shape (as a bad migration/import could).
    getRawDb()
      .prepare("UPDATE templates SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ configuration: { executionProvider: "nonsense" } }), id);

    const res = await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${id}/instantiate`, {}),
      idCtx(id),
    );
    expect(res.status).toBe(400);
  });

  it("a tampered payload with a privileged/invalid provider is rejected, not applied", async () => {
    const id = await createTpl("house", housePayload);
    getRawDb()
      .prepare("UPDATE templates SET payload = ? WHERE id = ?")
      .run(
        JSON.stringify({
          ...housePayload,
          configuration: { ...housePayload.configuration, executionProvider: "shell-escape" },
        }),
        id,
      );
    const res = await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${id}/instantiate`, {}),
      idCtx(id),
    );
    expect(res.status).toBe(400);
    // No house row was created from the invalid template.
    const count = getRawDb()
      .prepare("SELECT COUNT(*) c FROM houses WHERE name = 'Research House'")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("project template instantiate with a duplicate directory → 409", async () => {
    // Register a project at tmpDir first.
    const projectRoute = await import("@/app/api/projects/route");
    await projectRoute.POST(
      jsonReq("POST", `${BASE}/api/projects`, { name: "P1", directory: tmpDir }),
    );
    const id = await createTpl("project", projectPayload, "Dup Dir Tpl");
    const res = await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${id}/instantiate`, { directory: tmpDir }),
      idCtx(id),
    );
    expect(res.status).toBe(409);
  });

  it("PATCH cannot swap a house template's payload to a project-shaped one", async () => {
    const id = await createTpl("house", housePayload);
    const res = await patchTemplate(
      jsonReq("PATCH", `${BASE}/api/templates/${id}`, { payload: projectPayload }),
      idCtx(id),
    );
    // The project payload fails houseTemplatePayloadSchema → 400.
    expect(res.status).toBe(400);
  });

  it("PATCH cannot swap a project template's payload to a house-shaped one (M1: reject, not strip)", async () => {
    const id = await createTpl("project", projectPayload, "No Strip Project");
    const res = await patchTemplate(
      jsonReq("PATCH", `${BASE}/api/templates/${id}`, { payload: housePayload }),
      idCtx(id),
    );
    // houseTemplatePayloadSchema is `.strict()`, so the unknown agent/config keys
    // are rejected instead of being silently stripped into a partial payload.
    expect(res.status).toBe(400);

    // The original payload must survive intact (no defaultModel/instructions loss).
    const get = await getTemplate(req(`${BASE}/api/templates/${id}`), idCtx(id));
    const { template } = (await get.json()) as { template: { payload: unknown } };
    expect(template.payload).toEqual(projectPayload);
  });

  it("POST rejects a wrong-kind payload in BOTH directions", async () => {
    // project payload under kind=house
    const houseMismatch = await createTemplateRoute(
      jsonReq("POST", `${BASE}/api/templates`, {
        kind: "house",
        name: "Post Mismatch House",
        payload: projectPayload,
      }),
    );
    expect(houseMismatch.status).toBe(400);

    // house payload under kind=project
    const projectMismatch = await createTemplateRoute(
      jsonReq("POST", `${BASE}/api/templates`, {
        kind: "project",
        name: "Post Mismatch Project",
        payload: housePayload,
      }),
    );
    expect(projectMismatch.status).toBe(400);
  });

  it("a correct-kind payload still succeeds (M1: no over-rejection)", async () => {
    const id = await createTpl("project", projectPayload, "Good Project");
    const res = await patchTemplate(
      jsonReq("PATCH", `${BASE}/api/templates/${id}`, {
        payload: { ...projectPayload, instructions: "Updated instructions." },
      }),
      idCtx(id),
    );
    expect(res.status).toBe(200);
    const { template } = (await res.json()) as { template: { payload: { instructions: string } } };
    expect(template.payload.instructions).toBe("Updated instructions.");
  });

  it("instantiation of a house template produces a FULLY configured house (provider/model/allowlist/tools/permissions/approval)", async () => {
    const id = await createTpl("house", {
      ...housePayload,
      configuration: {
        ...housePayload.configuration,
        modelId: "special-model",
        workspaceAllowlist: [tmpDir],
        tools: ["fs", "shell", "git"],
        permissions: { fileSystem: "allow", shell: "deny", network: "allow", git: "deny" },
        approvalPolicy: "risky_only",
        concurrency: 3,
      },
    });
    const res = await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${id}/instantiate`, { name: "Full Config House" }),
      idCtx(id),
    );
    expect(res.status).toBe(201);
    const { house } = (await res.json()) as {
      house: {
        configuration: {
          modelId: string;
          workspaceAllowlist: string[];
          tools: string[];
          permissions: Record<string, string>;
          approvalPolicy: string;
          concurrency: number;
        };
        agents: unknown[];
      };
    };
    expect(house.configuration.modelId).toBe("special-model");
    expect(house.configuration.workspaceAllowlist).toEqual([tmpDir]);
    expect(house.configuration.tools).toEqual(["fs", "shell", "git"]);
    expect(house.configuration.permissions).toEqual({
      fileSystem: "allow",
      shell: "deny",
      network: "allow",
      git: "deny",
    });
    expect(house.configuration.approvalPolicy).toBe("risky_only");
    expect(house.configuration.concurrency).toBe(3);
    expect(house.agents).toHaveLength(1);
  });

  it("GET template returns the parsed payload round-trip (no double-encoding)", async () => {
    const id = await createTpl("project", projectPayload);
    const res = await getTemplate(req(`${BASE}/api/templates/${id}`), idCtx(id));
    const { template } = (await res.json()) as { template: { payload: unknown } };
    expect(template.payload).toEqual(projectPayload);
  });
});

/* ================================================================== */
/* Monitoring — degradation                                           */
/* ================================================================== */

describe("ADVERSARIAL: monitoring degrades with an unreachable provider", () => {
  it("GET /api/monitoring returns 200 with providerHealth=false (engine off)", async () => {
    // Force the health probe to fail by pointing OpenCode at an unroutable URL.
    const prev = process.env.OPENCODE_BASE_URL;
    process.env.OPENCODE_BASE_URL = "http://127.0.0.1:1";
    try {
      const res = await getMonitoring(req(`${BASE}/api/monitoring`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        providerHealth: boolean;
        engineHealth: string;
        queueDepth: number;
      };
      expect(body.providerHealth).toBe(false);
      expect(body.engineHealth).toBe("offline");
      expect(body.queueDepth).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_BASE_URL;
      else process.env.OPENCODE_BASE_URL = prev;
    }
  });
});

/* ================================================================== */
/* Task PATCH — cross-house agentId retention                         */
/* ================================================================== */

describe("ADVERSARIAL: task PATCH to a new house must not retain a foreign agentId", () => {
  it("PATCHing houseId alone clears a now-foreign agentId (fixed)", async () => {
    const { POST: createTaskRoute } = await import("@/app/api/tasks/route");
    const { PATCH: patchTask } = await import("@/app/api/tasks/[id]/route");
    const { GET: getHouse } = await import("@/app/api/houses/[id]/route");

    // Two houses.
    const hA = (await (
      await createHouseRoute(
        jsonReq("POST", `${BASE}/api/houses`, {
          name: "House A",
          agent: { name: "A", role: "R" },
          configuration: housePayload.configuration,
        }),
      )
    ).json()) as { house: { id: string; agents: Array<{ id: string }> } };
    const hB = (await (
      await createHouseRoute(
        jsonReq("POST", `${BASE}/api/houses`, {
          name: "House B",
          agent: { name: "B", role: "R" },
          configuration: housePayload.configuration,
        }),
      )
    ).json()) as { house: { id: string; agents: Array<{ id: string }> } };
    const agentA = hA.house.agents[0].id;

    const created = (await (
      await createTaskRoute(
        jsonReq("POST", `${BASE}/api/tasks`, {
          title: "Cross-house move",
          houseId: hA.house.id,
          agentId: agentA,
        }),
      )
    ).json()) as { task: { id: string } };

    // PATCH only houseId → the route's agent guard is skipped (agentId absent).
    const patched = await patchTask(
      jsonReq("PATCH", `${BASE}/api/tasks/${created.task.id}`, { houseId: hB.house.id }),
      idCtx(created.task.id),
    );
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { task: { houseId: string; agentId: string | null } };
    // Moving to House B clears House A's agent (falls back to B's default).
    expect(body.task.houseId).toBe(hB.house.id);
    expect(body.task.agentId).toBeNull();

    void getHouse;
  });

  it("PATCHing houseId to the SAME house keeps the agentId (no spurious clear)", async () => {
    const { POST: createTaskRoute } = await import("@/app/api/tasks/route");
    const { PATCH: patchTask } = await import("@/app/api/tasks/[id]/route");
    const hA = (await (
      await createHouseRoute(
        jsonReq("POST", `${BASE}/api/houses`, {
          name: "Same House",
          agent: { name: "A", role: "R" },
          configuration: housePayload.configuration,
        }),
      )
    ).json()) as { house: { id: string; agents: Array<{ id: string }> } };
    const agentA = hA.house.agents[0].id;
    const created = (await (
      await createTaskRoute(
        jsonReq("POST", `${BASE}/api/tasks`, {
          title: "Same-house move",
          houseId: hA.house.id,
          agentId: agentA,
        }),
      )
    ).json()) as { task: { id: string } };

    const res = await patchTask(
      jsonReq("PATCH", `${BASE}/api/tasks/${created.task.id}`, { houseId: hA.house.id }),
      idCtx(created.task.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { agentId: string | null } };
    expect(body.task.agentId).toBe(agentA);
  });

  it("PATCHing agentId to an agent of a different house is rejected (guard works when agentId present)", async () => {
    const { POST: createTaskRoute } = await import("@/app/api/tasks/route");
    const { PATCH: patchTask } = await import("@/app/api/tasks/[id]/route");
    const hA = (await (
      await createHouseRoute(
        jsonReq("POST", `${BASE}/api/houses`, {
          name: "Guard A",
          agent: { name: "A", role: "R" },
          configuration: housePayload.configuration,
        }),
      )
    ).json()) as { house: { id: string; agents: Array<{ id: string }> } };
    const hB = (await (
      await createHouseRoute(
        jsonReq("POST", `${BASE}/api/houses`, {
          name: "Guard B",
          agent: { name: "B", role: "R" },
          configuration: housePayload.configuration,
        }),
      )
    ).json()) as { house: { id: string; agents: Array<{ id: string }> } };
    const created = (await (
      await createTaskRoute(
        jsonReq("POST", `${BASE}/api/tasks`, { title: "Guard move", houseId: hA.house.id }),
      )
    ).json()) as { task: { id: string } };

    const res = await patchTask(
      jsonReq("PATCH", `${BASE}/api/tasks/${created.task.id}`, {
        houseId: hB.house.id,
        agentId: hA.house.agents[0].id,
      }),
      idCtx(created.task.id),
    );
    expect(res.status).toBe(400);
  });
});

/* ================================================================== */
/* listAuditLog repo pagination stability                             */
/* ================================================================== */

describe("ADVERSARIAL: listAuditLog stable pagination", () => {
  it("pages do not overlap even when created_at ties (rowid tiebreak)", async () => {
    // Bootstrap the DB via a route (runs migrate + seeds), then seed audit rows.
    await createHouseRoute(
      jsonReq("POST", `${BASE}/api/houses`, {
        name: "Pagination House",
        agent: { name: "A", role: "R" },
        configuration: housePayload.configuration,
      }),
    );
    const sqlite = getRawDb();
    const stamp = "2026-01-01T00:00:00.000Z";
    const ins = sqlite.prepare(
      "INSERT INTO audit_log (id,actor,action,entity_type,entity_id,metadata,created_at) VALUES (?, 'user','create','house',?,'{}',?)",
    );
    for (let i = 0; i < 30; i++) ins.run(`s-${i}`, `e-${i}`, stamp);
    const p1 = listAuditLog(getDb(), { limit: 10, offset: 0 }).map((e) => e.id);
    const p2 = listAuditLog(getDb(), { limit: 10, offset: 10 }).map((e) => e.id);
    expect(p1).toHaveLength(10);
    expect(p2).toHaveLength(10);
    expect(p1.some((id) => p2.includes(id))).toBe(false);
  });
});
