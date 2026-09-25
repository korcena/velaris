/**
 * Integration tests — template routes (Phase 6 Stage C), invoked directly with
 * `new NextRequest()`.
 *
 * DB isolation contract (matches tests/integration/api-routes.test.ts):
 * VELARIS_DB_PATH points at a fresh temp file per test, set BEFORE importing
 * the route modules; resetDbForTests() + resetBootstrapForTests() run in
 * beforeEach, so bootstrap seeds the default templates + High Lord.
 *
 * Covers: list/create/update/delete; seeded immutability (409); duplicate name
 * (409); 404s; zod 400s; and instantiation → a fully configured house/project
 * with a persistent audit row (the §10 acceptance criterion).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { resetDbForTests } from "@/lib/db";
import { resetBootstrapForTests } from "@/server/bootstrap";

import { GET as listTemplates, POST as createTemplateRoute } from "@/app/api/templates/route";
import {
  GET as getTemplate,
  PATCH as patchTemplate,
  DELETE as deleteTemplateRoute,
} from "@/app/api/templates/[id]/route";
import { POST as instantiateRoute } from "@/app/api/templates/[id]/instantiate/route";
import { GET as getHouseById } from "@/app/api/houses/[id]/route";
import { GET as listProjects } from "@/app/api/projects/route";
import { GET as getAuditLog } from "@/app/api/audit-log/route";

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-template-routes-"));
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

function idCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const housePayload = {
  description: "A route-test house template",
  agent: { name: "RouteTemplar", role: "Knight · tester" },
  configuration: {
    systemPrompt: "You are a route templar.",
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

const projectPayload = {
  description: "A route-test project template",
  defaultModel: "glm-5.3",
  instructions: "Read the conventions.",
};

async function createHouseTemplate(name = `House Tpl ${Date.now()}`): Promise<string> {
  const res = await createTemplateRoute(
    jsonReq("POST", `${BASE}/api/templates`, {
      kind: "house",
      name,
      description: "d",
      payload: housePayload,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { template: { id: string } }).template.id;
}

/* ================================================================== */
/* CRUD routes                                                        */
/* ================================================================== */

describe("template CRUD routes", () => {
  it("GET seeds the defaults on boot; POST creates a user template → 201", async () => {
    const list = await listTemplates(req(`${BASE}/api/templates`));
    expect(list.status).toBe(200);
    const { templates } = (await list.json()) as { templates: Array<{ isSeeded: boolean }> };
    expect(templates.length).toBeGreaterThanOrEqual(4);
    expect(templates.some((t) => t.isSeeded)).toBe(true);

    const created = await createTemplateRoute(
      jsonReq("POST", `${BASE}/api/templates`, {
        kind: "project",
        name: "My Repo Tpl",
        payload: projectPayload,
      }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { template: { id: string; isSeeded: boolean } };
    expect(body.template.isSeeded).toBe(false);
  });

  it("GET ?kind= filters", async () => {
    const res = await listTemplates(req(`${BASE}/api/templates?kind=project`));
    const { templates } = (await res.json()) as { templates: Array<{ kind: string }> };
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every((t) => t.kind === "project")).toBe(true);
  });

  it("GET by id → 200; unknown → 404", async () => {
    const id = await createHouseTemplate();
    const okRes = await getTemplate(req(`${BASE}/api/templates/${id}`), idCtx(id));
    expect(okRes.status).toBe(200);

    const missing = randomUUID();
    const miss = await getTemplate(req(`${BASE}/api/templates/${missing}`), idCtx(missing));
    expect(miss.status).toBe(404);
  });

  it("PATCH updates a user template → 200; unknown → 404", async () => {
    const id = await createHouseTemplate();
    const res = await patchTemplate(
      jsonReq("PATCH", `${BASE}/api/templates/${id}`, { name: "Renamed Tpl" }),
      idCtx(id),
    );
    expect(res.status).toBe(200);
    const { template } = (await res.json()) as { template: { name: string } };
    expect(template.name).toBe("Renamed Tpl");

    const missing = randomUUID();
    const miss = await patchTemplate(
      jsonReq("PATCH", `${BASE}/api/templates/${missing}`, { name: "X" }),
      idCtx(missing),
    );
    expect(miss.status).toBe(404);
  });

  it("DELETE removes a user template → 204; unknown → 404", async () => {
    const id = await createHouseTemplate();
    const res = await deleteTemplateRoute(req(`${BASE}/api/templates/${id}`, { method: "DELETE" }), idCtx(id));
    expect(res.status).toBe(204);

    const again = await deleteTemplateRoute(
      req(`${BASE}/api/templates/${id}`, { method: "DELETE" }),
      idCtx(id),
    );
    expect(again.status).toBe(404);
  });

  it("rejects invalid bodies with 400 (zod, malformed JSON, kind/payload mismatch)", async () => {
    const invalid = await createTemplateRoute(
      jsonReq("POST", `${BASE}/api/templates`, { kind: "house", name: "" }),
    );
    expect(invalid.status).toBe(400);

    const malformed = await createTemplateRoute(
      new NextRequest(`${BASE}/api/templates`, {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(malformed.status).toBe(400);

    // project payload under kind=house fails the discriminated union.
    const mismatch = await createTemplateRoute(
      jsonReq("POST", `${BASE}/api/templates`, {
        kind: "house",
        name: "Mismatch",
        payload: projectPayload,
      }),
    );
    expect(mismatch.status).toBe(400);
  });

  it("rejects a duplicate (kind,name) with 409", async () => {
    await createHouseTemplate("Unique Name");
    const dup = await createTemplateRoute(
      jsonReq("POST", `${BASE}/api/templates`, {
        kind: "house",
        name: "Unique Name",
        payload: housePayload,
      }),
    );
    expect(dup.status).toBe(409);
  });

  it("seeded templates are immutable: PATCH/DELETE → 409", async () => {
    const list = await listTemplates(req(`${BASE}/api/templates?kind=house`));
    const { templates } = (await list.json()) as { templates: Array<{ id: string; isSeeded: boolean }> };
    const seeded = templates.find((t) => t.isSeeded)!;
    expect(seeded).toBeTruthy();

    const patched = await patchTemplate(
      jsonReq("PATCH", `${BASE}/api/templates/${seeded.id}`, { name: "Hacked" }),
      idCtx(seeded.id),
    );
    expect(patched.status).toBe(409);

    const deleted = await deleteTemplateRoute(
      req(`${BASE}/api/templates/${seeded.id}`, { method: "DELETE" }),
      idCtx(seeded.id),
    );
    expect(deleted.status).toBe(409);
  });
});

/* ================================================================== */
/* Instantiation — the §10 acceptance criterion                       */
/* ================================================================== */

describe("template instantiation route", () => {
  it("instantiates a seeded house template → a fully configured house persists", async () => {
    const list = await listTemplates(req(`${BASE}/api/templates?kind=house`));
    const { templates } = (await list.json()) as {
      templates: Array<{ id: string; name: string; isSeeded: boolean }>;
    };
    const seeded = templates.find((t) => t.name === "Engineering House")!;
    expect(seeded).toBeTruthy();

    const res = await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${seeded.id}/instantiate`, { name: "My Engineering" }),
      idCtx(seeded.id),
    );
    expect(res.status).toBe(201);
    const { house } = (await res.json()) as {
      house: {
        id: string;
        name: string;
        configuration: { executionProvider: string; modelId: string; approvalPolicy: string };
        agent: { name: string };
        agents: Array<{ id: string }>;
      };
    };
    expect(house.name).toBe("My Engineering");
    expect(house.agent.name).toBe("Engineer");
    expect(house.configuration.executionProvider).toBe("opencode");
    expect(house.configuration.modelId).toBe("glm-5.3");
    expect(house.configuration.approvalPolicy).toBe("risky_only");
    expect(house.agents).toHaveLength(1);

    // It persists and is readable through the normal house route.
    const detail = await getHouseById(req(`${BASE}/api/houses/${house.id}`), idCtx(house.id));
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { house: { name: string } };
    expect(detailBody.house.name).toBe("My Engineering");
  });

  it("instantiates a user house template with an agent-name override", async () => {
    const id = await createHouseTemplate();
    const res = await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${id}/instantiate`, { agentName: "Override" }),
      idCtx(id),
    );
    expect(res.status).toBe(201);
    const { house } = (await res.json()) as { house: { agent: { name: string } } };
    expect(house.agent.name).toBe("Override");
  });

  it("instantiates a project template (directory supplied) → 201 { project }", async () => {
    const created = await createTemplateRoute(
      jsonReq("POST", `${BASE}/api/templates`, {
        kind: "project",
        name: "Project Tpl",
        payload: projectPayload,
      }),
    );
    const { template } = (await created.json()) as { template: { id: string } };

    const res = await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${template.id}/instantiate`, { directory: tmpDir }),
      idCtx(template.id),
    );
    expect(res.status).toBe(201);
    const { project } = (await res.json()) as {
      project: { id: string; directory: string; defaultModel: string; instructions: string };
    };
    expect(project.directory).toBe(tmpDir);
    expect(project.defaultModel).toBe("glm-5.3");
    expect(project.instructions).toBe("Read the conventions.");

    const list = await listProjects();
    const { projects } = (await list.json()) as { projects: Array<{ id: string }> };
    expect(projects.some((p) => p.id === project.id)).toBe(true);
  });

  it("requires a directory for a project template (400)", async () => {
    const created = await createTemplateRoute(
      jsonReq("POST", `${BASE}/api/templates`, {
        kind: "project",
        name: "Needs Dir",
        payload: projectPayload,
      }),
    );
    const { template } = (await created.json()) as { template: { id: string } };
    const res = await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${template.id}/instantiate`, {}),
      idCtx(template.id),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a nonexistent directory via the existing repo check (400)", async () => {
    const created = await createTemplateRoute(
      jsonReq("POST", `${BASE}/api/templates`, {
        kind: "project",
        name: "Bad Dir",
        payload: projectPayload,
      }),
    );
    const { template } = (await created.json()) as { template: { id: string } };
    const res = await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${template.id}/instantiate`, {
        directory: path.join(tmpDir, "does-not-exist"),
      }),
      idCtx(template.id),
    );
    expect(res.status).toBe(400);
  });

  it("unknown template → 404", async () => {
    const missing = randomUUID();
    const res = await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${missing}/instantiate`, {}),
      idCtx(missing),
    );
    expect(res.status).toBe(404);
  });

  it("writes `instantiate` audit rows for house + project", async () => {
    const houseId = await createHouseTemplate("Audit Tpl");
    await instantiateRoute(
      jsonReq("POST", `${BASE}/api/templates/${houseId}/instantiate`, {}),
      idCtx(houseId),
    );
    const audit = await getAuditLog(req(`${BASE}/api/audit-log?entityType=house`));
    const { entries } = (await audit.json()) as {
      entries: Array<{ action: string; metadata: Record<string, unknown> }>;
    };
    const instantiateEntry = entries.find((e) => e.action === "instantiate");
    expect(instantiateEntry).toBeTruthy();
    expect(instantiateEntry!.metadata.templateId).toBe(houseId);
  });
});
