/**
 * Integration tests — Next.js API route handlers invoked directly with
 * `new Request(...)` against a temp SQLite DB (IMPLEMENTATION_PLAN §5.6).
 *
 * Coverage per resource (houses, projects, provider-configs, tasks):
 *  - Happy path: POST create → 201 + body shape; GET list → 200;
 *    PATCH update → 200; GET by id → 200/404.
 *  - Error paths: 400 (zod validation, malformed JSON), 404 (unknown id),
 *    409 (duplicate project directory, delete non-archived house),
 *    422 (invalid house status transition, e.g. archived→active).
 *  - Health endpoint: 200, db ok, engine heartbeat present/absent.
 *
 * DB isolation: VELARIS_DB_PATH env points at a fresh temp file per test,
 * set BEFORE importing the route modules; resetDbForTests() in the
 * beforeEach drops the module-level singleton so each test gets its own DB.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { resetDbForTests, getRawDb } from "@/lib/db";
import { resetBootstrapForTests } from "@/server/bootstrap";
import { DEFAULT_HOUSES } from "@/shared/constants";

import { GET as getHealth } from "@/app/api/health/route";
import { GET as listHouses, POST as createHouseRoute } from "@/app/api/houses/route";
import {
  GET as getHouseById,
  PATCH as patchHouse,
  DELETE as deleteHouseRoute,
} from "@/app/api/houses/[id]/route";
import { GET as listProjects, POST as createProjectRoute } from "@/app/api/projects/route";
import {
  GET as getProjectById,
  PATCH as patchProject,
  DELETE as deleteProjectRoute,
} from "@/app/api/projects/[id]/route";
import {
  GET as listProviderConfigs,
  POST as createProviderConfigRoute,
} from "@/app/api/provider-configs/route";
import {
  GET as getProviderConfigById,
  PATCH as patchProviderConfig,
  DELETE as deleteProviderConfigRoute,
} from "@/app/api/provider-configs/[id]/route";
import { GET as listTasks, POST as createTaskRoute } from "@/app/api/tasks/route";
import {
  GET as getTaskById,
  PATCH as patchTask,
  DELETE as deleteTaskRoute,
} from "@/app/api/tasks/[id]/route";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const BASE = "http://localhost:3000";
let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  resetBootstrapForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-api-"));
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

/** A syntactically-invalid JSON body. */
function malformedReq(method: string, url: string): NextRequest {
  return new NextRequest(url, {
    method,
    body: "{not valid json",
    headers: { "content-type": "application/json" },
  });
}

function idCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/* ------------------------------------------------------------------ */
/* Shared payload builders                                            */
/* ------------------------------------------------------------------ */

const fullHousePayload = {
  name: "House of Shadows",
  description: "Quiet, precise engineering work after dark",
  agent: { name: "Azriel", role: "Shadow-singer · senior engineer" },
  configuration: {
    systemPrompt: "You are Azriel.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: ["/home/kate/development/personal-projects/velaris"],
    tools: ["fs", "shell", "git"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  },
};

async function createHouse(): Promise<{ id: string }> {
  const res = await createHouseRoute(jsonReq("POST", `${BASE}/api/houses`, fullHousePayload));
  expect(res.status).toBe(201);
  const body = await res.json();
  return { id: body.house.id as string };
}

async function createProject(directory: string): Promise<{ id: string }> {
  const res = await createProjectRoute(
    jsonReq("POST", `${BASE}/api/projects`, {
      name: "Velaris",
      description: "The city",
      directory,
    }),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  return { id: body.project.id as string };
}

/* ================================================================== */
/* Health                                                              */
/* ================================================================== */

describe("GET /api/health", () => {
  it("returns 200 with db ok, migrations applied, heartbeat absent", async () => {
    const res = await getHealth(req(`${BASE}/api/health`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(body.migrations).toBe("applied");
    expect(body.engineHeartbeatAt).toBeNull();
  });

  it("surfaces the engine heartbeat when the engine wrote one", async () => {
    // First call bootstraps (migrations + seed).
    await getHealth(req(`${BASE}/api/health`));

    // Simulate the engine writing its heartbeat row.
    const at = new Date().toISOString();
    getRawDb()
      .prepare(
        `INSERT INTO engine_state (key, value, updated_at) VALUES ('engine_heartbeat_at', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(at, at);

    const res = await getHealth(req(`${BASE}/api/health`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engineHeartbeatAt).toBe(at);
  });

  it("auto-applies migrations on first call (boot) — tables exist afterwards", async () => {
    await getHealth(req(`${BASE}/api/health`));
    const tables = getRawDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const expected of [
      "houses",
      "agents",
      "agent_configurations",
      "projects",
      "provider_configs",
      "tasks",
      "engine_state",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

/* ================================================================== */
/* Houses                                                              */
/* ================================================================== */

describe("POST /api/houses", () => {
  it("creates with nested agent + configuration → 201 and full body shape (§5.4)", async () => {
    const res = await createHouseRoute(jsonReq("POST", `${BASE}/api/houses`, fullHousePayload));
    expect(res.status).toBe(201);
    const { house } = await res.json();

    expect(house.id).toEqual(expect.any(String));
    expect(house.name).toBe("House of Shadows");
    expect(house.description).toBe("Quiet, precise engineering work after dark");
    expect(house.status).toBe("active");
    expect(house.agent).toEqual({
      name: "Azriel",
      role: "Shadow-singer · senior engineer",
    });
    expect(house.configuration).toEqual({
      systemPrompt: "You are Azriel.",
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "glm-5.3",
      workspaceAllowlist: ["/home/kate/development/personal-projects/velaris"],
      tools: ["fs", "shell", "git"],
      permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
      approvalPolicy: "always",
      concurrency: 1,
    });
    expect(house.createdAt).toEqual(expect.any(String));
    expect(house.updatedAt).toEqual(expect.any(String));
  });

  it("rejects an invalid payload with 400 + ZodError issues", async () => {
    const res = await createHouseRoute(
      jsonReq("POST", `${BASE}/api/houses`, {
        name: "",
        agent: { name: "x" }, // role missing
        configuration: { systemPrompt: "p", executionProvider: "nope" },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("rejects malformed JSON with 400 (not 500)", async () => {
    const res = await createHouseRoute(malformedReq("POST", `${BASE}/api/houses`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid JSON/);
  });

  it("rejects concurrency < 1 with 400", async () => {
    const res = await createHouseRoute(
      jsonReq("POST", `${BASE}/api/houses`, {
        ...fullHousePayload,
        configuration: { ...fullHousePayload.configuration, concurrency: 0 },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/houses", () => {
  it("lists houses → 200 {houses: [...]}", async () => {
    const { id } = await createHouse();
    const res = await listHouses(req(`${BASE}/api/houses`));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Boot seeds the ten default ACOTAR houses, so the list is those plus the
    // created house; assert the created one is present and fully shaped rather
    // than a stale "empty grid" count.
    expect(body.houses.length).toBe(DEFAULT_HOUSES.length + 1);
    expect(body.houses.some((h: { id: string }) => h.id === id)).toBe(true);
    const created = body.houses.find((h: { id: string }) => h.id === id);
    expect(created.name).toBe("House of Shadows");
    // All ten seeded defaults are listed too.
    for (const h of DEFAULT_HOUSES) {
      expect(body.houses.some((x: { name: string }) => x.name === h.house.name)).toBe(true);
    }
  });

  it("excludes archived by default; includeArchived=true shows them", async () => {
    const { id } = await createHouse();
    await patchHouse(jsonReq("PATCH", `${BASE}/api/houses/${id}`, { status: "archived" }), idCtx(id));

    const hidden = await (await listHouses(req(`${BASE}/api/houses`))).json();
    // The archived house is hidden; the ten seeded defaults remain.
    expect(hidden.houses.some((h: { id: string }) => h.id === id)).toBe(false);
    expect(hidden.houses).toHaveLength(DEFAULT_HOUSES.length);

    const all = await (
      await listHouses(req(`${BASE}/api/houses?includeArchived=true`))
    ).json();
    expect(all.houses.some((h: { id: string }) => h.id === id)).toBe(true);
    expect(all.houses).toHaveLength(DEFAULT_HOUSES.length + 1);
    const archived = all.houses.find((h: { id: string }) => h.id === id);
    expect(archived.status).toBe("archived");
  });
});

describe("GET /api/houses/{id}", () => {
  it("returns 200 with the house for a known id", async () => {
    const { id } = await createHouse();
    const res = await getHouseById(req(`${BASE}/api/houses/${id}`), idCtx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.house.id).toBe(id);
  });

  it("returns 404 for an unknown id", async () => {
    const missing = randomUUID();
    const res = await getHouseById(req(`${BASE}/api/houses/${missing}`), idCtx(missing));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});

describe("PATCH /api/houses/{id}", () => {
  it("updates fields (incl. partial nested agent/config) → 200", async () => {
    const { id } = await createHouse();
    const res = await patchHouse(
      jsonReq("PATCH", `${BASE}/api/houses/${id}`, {
        description: "Updated description",
        agent: { role: "Night-tracker" },
        configuration: { modelId: "new-model" },
      }),
      idCtx(id),
    );
    expect(res.status).toBe(200);
    const { house } = await res.json();
    expect(house.description).toBe("Updated description");
    expect(house.agent.name).toBe("Azriel"); // preserved
    expect(house.agent.role).toBe("Night-tracker"); // patched
    expect(house.configuration.modelId).toBe("new-model"); // patched
    expect(house.configuration.systemPrompt).toBe("You are Azriel."); // preserved
  });

  it("applies a valid status transition active → disabled → 200", async () => {
    const { id } = await createHouse();
    const res = await patchHouse(
      jsonReq("PATCH", `${BASE}/api/houses/${id}`, { status: "disabled" }),
      idCtx(id),
    );
    expect(res.status).toBe(200);
    const { house } = await res.json();
    expect(house.status).toBe("disabled");
  });

  it("rejects an invalid transition archived → active with 422", async () => {
    const { id } = await createHouse();
    // active → archived is legal…
    await patchHouse(jsonReq("PATCH", `${BASE}/api/houses/${id}`, { status: "archived" }), idCtx(id));
    // …but archived is terminal.
    const res = await patchHouse(
      jsonReq("PATCH", `${BASE}/api/houses/${id}`, { status: "active" }),
      idCtx(id),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid status transition/);
  });

  it("rejects an unknown status value with 400 (not silently ignored)", async () => {
    const { id } = await createHouse();
    const res = await patchHouse(
      jsonReq("PATCH", `${BASE}/api/houses/${id}`, { status: "bogus" }),
      idCtx(id),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown id", async () => {
    const missing = randomUUID();
    const res = await patchHouse(
      jsonReq("PATCH", `${BASE}/api/houses/${missing}`, { name: "X" }),
      idCtx(missing),
    );
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON with 400", async () => {
    const { id } = await createHouse();
    const res = await patchHouse(malformedReq("PATCH", `${BASE}/api/houses/${id}`), idCtx(id));
    expect(res.status).toBe(400);
  });

  it("rejects a validation failure (concurrency 0) with 400", async () => {
    const { id } = await createHouse();
    const res = await patchHouse(
      jsonReq("PATCH", `${BASE}/api/houses/${id}`, {
        configuration: { concurrency: 0 },
      }),
      idCtx(id),
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/houses/{id}", () => {
  it("returns 204 when the house is archived", async () => {
    const { id } = await createHouse();
    await patchHouse(jsonReq("PATCH", `${BASE}/api/houses/${id}`, { status: "archived" }), idCtx(id));
    const res = await deleteHouseRoute(req(`${BASE}/api/houses/${id}`, { method: "DELETE" }), idCtx(id));
    expect(res.status).toBe(204);

    const gone = await getHouseById(req(`${BASE}/api/houses/${id}`), idCtx(id));
    expect(gone.status).toBe(404);
  });

  it("returns 409 when the house is not archived (delete-only-when-archived)", async () => {
    const { id } = await createHouse();
    const res = await deleteHouseRoute(req(`${BASE}/api/houses/${id}`, { method: "DELETE" }), idCtx(id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/archived/i);
  });

  it("returns 404 for an unknown id", async () => {
    const missing = randomUUID();
    const res = await deleteHouseRoute(
      req(`${BASE}/api/houses/${missing}`, { method: "DELETE" }),
      idCtx(missing),
    );
    expect(res.status).toBe(404);
  });
});

/* ================================================================== */
/* Projects                                                            */
/* ================================================================== */

describe("POST /api/projects", () => {
  let projDir: string;

  beforeEach(() => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-projdir-"));
  });
  afterEach(() => {
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it("registers a real absolute existing directory → 201 with git info", async () => {
    const res = await createProjectRoute(
      jsonReq("POST", `${BASE}/api/projects`, {
        name: "Velaris",
        description: "The city",
        directory: projDir,
      }),
    );
    expect(res.status).toBe(201);
    const { project } = await res.json();
    expect(project.id).toEqual(expect.any(String));
    expect(project.directory).toBe(projDir);
    expect(project.gitInfo).toEqual({ branch: null, remote: null, dirty: false });
  });

  it("auto-detects git info when the directory is a repo", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init -b main", { cwd: projDir });
    execSync("git config user.email t@t.t && git config user.name T", { cwd: projDir });
    fs.writeFileSync(path.join(projDir, "a.txt"), "a");
    execSync("git add . && git commit -m init", { cwd: projDir });

    const res = await createProjectRoute(
      jsonReq("POST", `${BASE}/api/projects`, { name: "Repo", directory: projDir }),
    );
    expect(res.status).toBe(201);
    const { project } = await res.json();
    expect(project.gitInfo.branch).toBe("main");
    expect(project.gitInfo.dirty).toBe(false);
  });

  it("rejects a nonexistent directory with 400", async () => {
    const res = await createProjectRoute(
      jsonReq("POST", `${BASE}/api/projects`, {
        name: "Ghost",
        directory: `/nonexistent-${Date.now()}/dir`,
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/directory/i);
  });

  it("rejects a relative directory with 400 (zod)", async () => {
    const res = await createProjectRoute(
      jsonReq("POST", `${BASE}/api/projects`, {
        name: "Rel",
        directory: "relative/dir",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate directory with 409", async () => {
    await createProject(projDir);
    const res = await createProjectRoute(
      jsonReq("POST", `${BASE}/api/projects`, {
        name: "Dup",
        directory: projDir,
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await createProjectRoute(malformedReq("POST", `${BASE}/api/projects`));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects + /api/projects/{id}", () => {
  let projDir: string;
  beforeEach(() => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-projdir-"));
  });
  afterEach(() => {
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it("lists → 200; get by id → 200; unknown → 404", async () => {
    const { id } = await createProject(projDir);

    const list = await listProjects();
    expect(list.status).toBe(200);
    expect((await list.json()).projects).toHaveLength(1);

    const one = await getProjectById(req(`${BASE}/api/projects/${id}`), idCtx(id));
    expect(one.status).toBe(200);

    const missing = randomUUID();
    const none = await getProjectById(req(`${BASE}/api/projects/${missing}`), idCtx(missing));
    expect(none.status).toBe(404);
  });
});

describe("PATCH /api/projects/{id}", () => {
  let projDir: string;
  beforeEach(() => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-projdir-"));
  });
  afterEach(() => {
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it("updates name/description → 200", async () => {
    const { id } = await createProject(projDir);
    const res = await patchProject(
      jsonReq("PATCH", `${BASE}/api/projects/${id}`, {
        name: "Renamed",
        description: "new desc",
      }),
      idCtx(id),
    );
    expect(res.status).toBe(200);
    const { project } = await res.json();
    expect(project.name).toBe("Renamed");
    expect(project.directory).toBe(projDir);
  });

  it("rejects malformed JSON with 400", async () => {
    const { id } = await createProject(projDir);
    const res = await patchProject(malformedReq("PATCH", `${BASE}/api/projects/${id}`), idCtx(id));
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown id", async () => {
    const missing = randomUUID();
    const res = await patchProject(
      jsonReq("PATCH", `${BASE}/api/projects/${missing}`, { name: "X" }),
      idCtx(missing),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/{id}", () => {
  let projDir: string;
  beforeEach(() => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-projdir-"));
  });
  afterEach(() => {
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it("deletes → 204", async () => {
    const { id } = await createProject(projDir);
    const res = await deleteProjectRoute(
      req(`${BASE}/api/projects/${id}`, { method: "DELETE" }),
      idCtx(id),
    );
    expect(res.status).toBe(204);
  });

  it("returns 409 when a task references the project", async () => {
    const { id } = await createProject(projDir);
    const task = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "T", projectId: id }),
    );
    expect(task.status).toBe(201);

    const res = await deleteProjectRoute(
      req(`${BASE}/api/projects/${id}`, { method: "DELETE" }),
      idCtx(id),
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 for unknown id", async () => {
    const missing = randomUUID();
    const res = await deleteProjectRoute(
      req(`${BASE}/api/projects/${missing}`, { method: "DELETE" }),
      idCtx(missing),
    );
    expect(res.status).toBe(404);
  });
});

/* ================================================================== */
/* Provider configs                                                    */
/* ================================================================== */

describe("provider-config routes", () => {
  it("GET lists the two seeded defaults after bootstrap → 200", async () => {
    // Any route bootstraps; hit the list directly.
    const res = await listProviderConfigs();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerConfigs).toHaveLength(2);

    const names = body.providerConfigs
      .map((c: { name: string }) => c.name)
      .sort();
    expect(names).toEqual(["Ollama (local)", "OpenCode (local)"]);
    for (const c of body.providerConfigs) {
      expect(c.isDefault).toBe(true);
    }
  });

  it("POST creates a config → 201 with body shape", async () => {
    const res = await createProviderConfigRoute(
      jsonReq("POST", `${BASE}/api/provider-configs`, {
        name: "OpenCode (remote)",
        type: "opencode",
        baseUrl: "http://remote:4096",
      }),
    );
    expect(res.status).toBe(201);
    const { providerConfig } = await res.json();
    expect(providerConfig.id).toEqual(expect.any(String));
    expect(providerConfig.name).toBe("OpenCode (remote)");
    expect(providerConfig.type).toBe("opencode");
    expect(providerConfig.baseUrl).toBe("http://remote:4096");
    expect(providerConfig.isDefault).toBe(false);
    expect(providerConfig.extra).toEqual({});
  });

  it("POST enforces one default per type (previous default demoted)", async () => {
    const res = await createProviderConfigRoute(
      jsonReq("POST", `${BASE}/api/provider-configs`, {
        name: "OpenCode (remote)",
        type: "opencode",
        baseUrl: "http://remote:4096",
        isDefault: true,
      }),
    );
    expect(res.status).toBe(201);

    const list = await (await listProviderConfigs()).json();
    const opencodeDefaults = list.providerConfigs.filter(
      (c: { type: string; isDefault: boolean }) => c.type === "opencode" && c.isDefault,
    );
    expect(opencodeDefaults).toHaveLength(1);
    expect(opencodeDefaults[0].name).toBe("OpenCode (remote)");
  });

  it("POST rejects a non-http baseUrl with 400", async () => {
    const res = await createProviderConfigRoute(
      jsonReq("POST", `${BASE}/api/provider-configs`, {
        name: "Bad",
        type: "opencode",
        baseUrl: "weird://url",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects malformed JSON with 400", async () => {
    const res = await createProviderConfigRoute(
      malformedReq("POST", `${BASE}/api/provider-configs`),
    );
    expect(res.status).toBe(400);
  });

  it("GET/PATCH/DELETE by id: happy path + 404", async () => {
    const created = await createProviderConfigRoute(
      jsonReq("POST", `${BASE}/api/provider-configs`, {
        name: "X",
        type: "ollama",
        baseUrl: "http://localhost:11434",
      }),
    );
    const { providerConfig } = await created.json();

    const got = await getProviderConfigById(
      req(`${BASE}/api/provider-configs/${providerConfig.id}`),
      idCtx(providerConfig.id),
    );
    expect(got.status).toBe(200);

    const patched = await patchProviderConfig(
      jsonReq("PATCH", `${BASE}/api/provider-configs/${providerConfig.id}`, {
        baseUrl: "http://elsewhere:11434",
      }),
      idCtx(providerConfig.id),
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()).providerConfig.baseUrl).toBe("http://elsewhere:11434");

    const deleted = await deleteProviderConfigRoute(
      req(`${BASE}/api/provider-configs/${providerConfig.id}`, { method: "DELETE" }),
      idCtx(providerConfig.id),
    );
    expect(deleted.status).toBe(204);

    const missing = randomUUID();
    expect(
      (await getProviderConfigById(req(`${BASE}/api/provider-configs/${missing}`), idCtx(missing))).status,
    ).toBe(404);
  });

  it("PATCH rejects malformed JSON with 400", async () => {
    const created = await (
      await createProviderConfigRoute(
        jsonReq("POST", `${BASE}/api/provider-configs`, {
          name: "Y",
          type: "ollama",
          baseUrl: "http://localhost:11434",
        }),
      )
    ).json();
    const res = await patchProviderConfig(
      malformedReq("PATCH", `${BASE}/api/provider-configs/${created.providerConfig.id}`),
      idCtx(created.providerConfig.id),
    );
    expect(res.status).toBe(400);
  });
});

/* ================================================================== */
/* Tasks                                                               */
/* ================================================================== */

describe("POST /api/tasks", () => {
  it("creates a task locked to status='queued' → 201 with defaults", async () => {
    const res = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "Fix the login bug" }),
    );
    expect(res.status).toBe(201);
    const { task } = await res.json();
    expect(task.id).toEqual(expect.any(String));
    expect(task.title).toBe("Fix the login bug");
    expect(task.status).toBe("queued"); // locked in Phase 1
    expect(task.type).toBe("general");
    expect(task.priority).toBe("medium");
    expect(task.houseId).toBeNull();
    expect(task.projectId).toBeNull();
  });

  it("accepts an extensible custom type", async () => {
    const res = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "T", type: "custom_quest" }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).task.type).toBe("custom_quest");
  });

  it("rejects an unknown priority with 400", async () => {
    const res = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "T", priority: "critical" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a nonexistent houseId with 400 (FK constraint mapped)", async () => {
    const res = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "T", houseId: randomUUID() }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a relative workingDirectory with 400 (CHECK constraint mapped)", async () => {
    const res = await createTaskRoute(
      jsonReq("POST", `${BASE}/api/tasks`, { title: "T", workingDirectory: "relative/path" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await createTaskRoute(malformedReq("POST", `${BASE}/api/tasks`));
    expect(res.status).toBe(400);
  });

  it("assigns a task to a real house + project", async () => {
    const house = await createHouse();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-projdir-"));
    try {
      const project = await createProject(dir);
      const res = await createTaskRoute(
        jsonReq("POST", `${BASE}/api/tasks`, {
          title: "Quest",
          houseId: house.id,
          projectId: project.id,
        }),
      );
      expect(res.status).toBe(201);
      const { task } = await res.json();
      expect(task.houseId).toBe(house.id);
      expect(task.projectId).toBe(project.id);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/tasks", () => {
  it("lists → 200 and supports ?houseId / ?status filters", async () => {
    const house = await createHouse();
    const t1 = await (
      await createTaskRoute(jsonReq("POST", `${BASE}/api/tasks`, { title: "T1", houseId: house.id }))
    ).json();
    await createTaskRoute(jsonReq("POST", `${BASE}/api/tasks`, { title: "T2" }));

    const all = await listTasks(req(`${BASE}/api/tasks`));
    expect(all.status).toBe(200);
    expect((await all.json()).tasks).toHaveLength(2);

    const forHouse = await listTasks(req(`${BASE}/api/tasks?houseId=${house.id}`));
    const houseTasks = (await forHouse.json()).tasks;
    expect(houseTasks).toHaveLength(1);
    expect(houseTasks[0].title).toBe("T1");

    const queued = await listTasks(req(`${BASE}/api/tasks?status=queued`));
    expect((await queued.json()).tasks).toHaveLength(2);
    const cancelled = await listTasks(req(`${BASE}/api/tasks?status=cancelled`));
    expect((await cancelled.json()).tasks).toHaveLength(0);

    // Cancel one, then the filters shift accordingly.
    await patchTask(
      jsonReq("PATCH", `${BASE}/api/tasks/${t1.task.id}`, { status: "cancelled" }),
      idCtx(t1.task.id),
    );
    const cancelledAfter = await (await listTasks(req(`${BASE}/api/tasks?status=cancelled`))).json();
    expect(cancelledAfter.tasks).toHaveLength(1);
    expect(cancelledAfter.tasks[0].id).toBe(t1.task.id);
  });
});

describe("GET/PATCH/DELETE /api/tasks/{id}", () => {
  async function makeTask(): Promise<string> {
    const res = await createTaskRoute(jsonReq("POST", `${BASE}/api/tasks`, { title: "T" }));
    return ((await res.json()) as { task: { id: string } }).task.id;
  }

  it("GET returns 200 for known id, 404 for unknown", async () => {
    const id = await makeTask();
    expect((await getTaskById(req(`${BASE}/api/tasks/${id}`), idCtx(id))).status).toBe(200);
    const missing = randomUUID();
    expect((await getTaskById(req(`${BASE}/api/tasks/${missing}`), idCtx(missing))).status).toBe(404);
  });

  it("PATCH updates mutable fields → 200", async () => {
    const id = await makeTask();
    const res = await patchTask(
      jsonReq("PATCH", `${BASE}/api/tasks/${id}`, {
        title: "Renamed",
        priority: "urgent",
        description: "more",
      }),
      idCtx(id),
    );
    expect(res.status).toBe(200);
    const { task } = await res.json();
    expect(task.title).toBe("Renamed");
    expect(task.priority).toBe("urgent");
    expect(task.description).toBe("more");
  });

  it("PATCH cancels a queued task (Phase 1's only allowed status change)", async () => {
    const id = await makeTask();
    const res = await patchTask(
      jsonReq("PATCH", `${BASE}/api/tasks/${id}`, { status: "cancelled" }),
      idCtx(id),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).task.status).toBe("cancelled");
  });

  it("PATCH rejects an out-of-enum status with 400 (zod)", async () => {
    const id = await makeTask();
    const res = await patchTask(
      jsonReq("PATCH", `${BASE}/api/tasks/${id}`, { status: "running" }),
      idCtx(id),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH rejects malformed JSON with 400", async () => {
    const id = await makeTask();
    const res = await patchTask(malformedReq("PATCH", `${BASE}/api/tasks/${id}`), idCtx(id));
    expect(res.status).toBe(400);
  });

  it("PATCH returns 404 for unknown id", async () => {
    const missing = randomUUID();
    const res = await patchTask(
      jsonReq("PATCH", `${BASE}/api/tasks/${missing}`, { title: "x" }),
      idCtx(missing),
    );
    expect(res.status).toBe(404);
  });

  it("DELETE removes the task → 204; unknown → 404", async () => {
    const id = await makeTask();
    const res = await deleteTaskRoute(req(`${BASE}/api/tasks/${id}`, { method: "DELETE" }), idCtx(id));
    expect(res.status).toBe(204);
    expect((await getTaskById(req(`${BASE}/api/tasks/${id}`), idCtx(id))).status).toBe(404);

    const missing = randomUUID();
    expect(
      (await deleteTaskRoute(req(`${BASE}/api/tasks/${missing}`, { method: "DELETE" }), idCtx(missing))).status,
    ).toBe(404);
  });
});