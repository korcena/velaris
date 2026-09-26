/**
 * Unit tests — multi-agent houses (Phase 6 Stage B): agent repo/service CRUD,
 * DTO `agents[]` + default-agent resolution, task-targeting routing, and the
 * Q9 audit writes for agent CRUD.
 *
 * Temp DB per test (migrate → run → teardown), mirroring house-seed.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import {
  createHouse,
  createAgent,
  listAgentsForHouse,
  getAgent,
  getHouse,
  updateAgent,
  deleteAgent,
  resolveDefaultAgent,
  resolveRuntimeAgent,
  agentBelongsToHouse,
  seedHighLordHouse,
  transitionHouseStatus,
  deleteHouse,
  LastAgentError,
  AgentNotFoundError,
} from "@/server/repositories/house-repo";
import {
  createAgentService,
  updateAgentService,
  deleteAgentService,
  HighLordTransitionError,
} from "@/server/services/house-service";
import { createTask, getTask } from "@/server/repositories/task-repo";
import { listAuditLog } from "@/server/repositories/audit-repo";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let dbPath: string;

function makeConfig(over: Partial<HouseConfiguration> = {}): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
    ...over,
  };
}

function seedHouse(name = "H") {
  return createHouse(getDb(), {
    name,
    description: null,
    agent: { name: "Azriel", role: "Shadow-singer" },
    configuration: makeConfig(),
  });
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-house-agents-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ================================================================== */
/* Repo CRUD                                                          */
/* ================================================================== */

describe("agent repository CRUD", () => {
  it("createAgent inserts the agent + exactly ONE configuration", () => {
    const db = getDb();
    const house = seedHouse();
    const agent = createAgent(db, house.id, {
      name: "Cassian",
      role: "General",
      configuration: makeConfig({ modelId: "cassian-model" }),
    });

    expect(agent.id).toBeTruthy();
    expect(agent.name).toBe("Cassian");
    expect(agent.role).toBe("General");
    expect(agent.configuration.modelId).toBe("cassian-model");

    const counts = getRawDb()
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM agents WHERE house_id = ?) AS a,
           (SELECT COUNT(*) FROM agent_configurations WHERE agent_id = ?) AS c`,
      )
      .get(house.id, agent.id) as { a: number; c: number };
    expect(counts).toEqual({ a: 2, c: 1 }); // default + new agent, one config each
  });

  it("listAgentsForHouse returns every agent OLDEST-FIRST with its config", () => {
    const db = getDb();
    const house = seedHouse();
    // Pin created_at so ordering is deterministic (same-millisecond inserts).
    createAgent(db, house.id, { name: "Second", role: "R2", configuration: makeConfig({ modelId: "m2" }) });
    const raw = getRawDb();
    raw.prepare("UPDATE agents SET created_at = '2026-01-02T00:00:00.000Z' WHERE name = 'Second'").run();
    raw.prepare("UPDATE agents SET created_at = '2026-01-01T00:00:00.000Z' WHERE name = 'Azriel'").run();

    const agents = listAgentsForHouse(db, house.id);
    expect(agents.map((a) => a.name)).toEqual(["Azriel", "Second"]);
    expect(agents[0].configuration.modelId).toBe("glm-5.3");
    expect(agents[1].configuration.modelId).toBe("m2");
    // The default agent is the oldest.
    expect(resolveDefaultAgent(db, house.id)?.name).toBe("Azriel");
  });

  it("updateAgent merges name/role/config keys without clobbering the rest", () => {
    const db = getDb();
    const house = seedHouse();
    const agent = createAgent(db, house.id, {
      name: "Cassian",
      role: "General",
      configuration: makeConfig({ modelId: "old-model", concurrency: 2 }),
    });

    const updated = updateAgent(db, agent.id, {
      role: "Commander",
      configuration: { modelId: "new-model" },
    });
    expect(updated.name).toBe("Cassian"); // untouched
    expect(updated.role).toBe("Commander");
    expect(updated.configuration.modelId).toBe("new-model");
    expect(updated.configuration.concurrency).toBe(2); // preserved
    expect(updated.configuration.systemPrompt).toBe("You are an agent."); // preserved
  });

  it("getAgent returns null for an unknown id; update/delete throw AgentNotFoundError", () => {
    const db = getDb();
    expect(getAgent(db, "nope")).toBeNull();
    expect(() => updateAgent(db, "nope", { name: "x" })).toThrow(AgentNotFoundError);
    expect(() => deleteAgent(db, "nope")).toThrow(AgentNotFoundError);
  });
});

/* ================================================================== */
/* Deletion rules                                                     */
/* ================================================================== */

describe("agent deletion rules", () => {
  it("refuses deleting the house's ONLY agent (LastAgentError)", () => {
    const db = getDb();
    const house = seedHouse();
    const only = listAgentsForHouse(db, house.id)[0];
    expect(() => deleteAgent(db, only.id)).toThrow(LastAgentError);
    expect(listAgentsForHouse(db, house.id)).toHaveLength(1);
  });

  it("deletes a non-last agent, cascades its config, and SET NULLs tasks.agent_id", () => {
    const db = getDb();
    const house = seedHouse();
    const second = createAgent(db, house.id, {
      name: "Second",
      role: "R2",
      configuration: makeConfig(),
    });
    const task = createTask(db, { title: "T", houseId: house.id, agentId: second.id });
    expect(getTask(db, task.id)?.agentId).toBe(second.id);

    deleteAgent(db, second.id);

    // Agent + config gone…
    expect(getAgent(db, second.id)).toBeNull();
    const configLeft = getRawDb()
      .prepare("SELECT COUNT(*) c FROM agent_configurations WHERE agent_id = ?")
      .get(second.id) as { c: number };
    expect(configLeft.c).toBe(0);
    // …the house keeps its default, and the task survives with agent_id NULL.
    expect(listAgentsForHouse(db, house.id)).toHaveLength(1);
    expect(getTask(db, task.id)?.agentId).toBeNull();
    expect(getTask(db, task.id)?.title).toBe("T");
  });

  it("deleting a house cascades ALL its agents + configs (multi-agent)", () => {
    const db = getDb();
    const house = seedHouse();
    createAgent(db, house.id, { name: "Second", role: "R2", configuration: makeConfig() });
    createAgent(db, house.id, { name: "Third", role: "R3", configuration: makeConfig() });
    transitionHouseStatus(db, house.id, "archived");
    deleteHouse(db, house.id);

    const counts = getRawDb()
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM agents WHERE house_id = ?) AS a,
           (SELECT COUNT(*) FROM agent_configurations) AS c`,
      )
      .get(house.id) as { a: number; c: number };
    expect(counts).toEqual({ a: 0, c: 0 });
  });
});

/* ================================================================== */
/* Routing resolution                                                 */
/* ================================================================== */

describe("resolveRuntimeAgent (task routing)", () => {
  it("honours an explicit agentId that belongs to the house", () => {
    const db = getDb();
    const house = seedHouse();
    const second = createAgent(db, house.id, { name: "Second", role: "R2", configuration: makeConfig() });
    expect(resolveRuntimeAgent(db, house.id, { agentId: second.id })?.id).toBe(second.id);
  });

  it("falls back to the house default (oldest) when agentId is null", () => {
    const db = getDb();
    const house = seedHouse();
    const defaultAgent = listAgentsForHouse(db, house.id)[0];
    expect(resolveRuntimeAgent(db, house.id, { agentId: null })?.id).toBe(defaultAgent.id);
    expect(resolveRuntimeAgent(db, house.id, {})?.id).toBe(defaultAgent.id);
  });

  it("falls back to the default when agentId does not belong to the house", () => {
    const db = getDb();
    const house = seedHouse();
    const other = seedHouse("Other");
    const foreign = listAgentsForHouse(db, other.id)[0];
    const defaultAgent = listAgentsForHouse(db, house.id)[0];
    expect(resolveRuntimeAgent(db, house.id, { agentId: foreign.id })?.id).toBe(defaultAgent.id);
  });

  it("agentBelongsToHouse is false for a cross-house or unknown agent", () => {
    const db = getDb();
    const house = seedHouse();
    const other = seedHouse("Other");
    const foreign = listAgentsForHouse(db, other.id)[0];
    expect(agentBelongsToHouse(db, foreign.id, house.id)).toBe(false);
    expect(agentBelongsToHouse(db, "missing", house.id)).toBe(false);
    expect(agentBelongsToHouse(db, listAgentsForHouse(db, house.id)[0].id, house.id)).toBe(true);
  });
});

/* ================================================================== */
/* DTO shape / backward compatibility                                 */
/* ================================================================== */

describe("HouseDto multi-agent shape (backward compatible)", () => {
  it("exposes agents[] oldest-first and mirrors the default agent on `agent`", () => {
    const db = getDb();
    const house = seedHouse();
    const second = createAgent(db, house.id, {
      name: "Second",
      role: "R2",
      configuration: makeConfig({ modelId: "m2" }),
    });
    // Pin oldest-first ordering.
    const raw = getRawDb();
    raw.prepare("UPDATE agents SET created_at = '2026-01-02T00:00:00.000Z' WHERE id = ?").run(second.id);
    raw.prepare("UPDATE agents SET created_at = '2026-01-01T00:00:00.000Z' WHERE name = 'Azriel'").run();

    const dto = getHouse(db, house.id)!;
    expect(dto.agents.map((a) => a.name)).toEqual(["Azriel", "Second"]);
    // Singular `agent`/`configuration` = the default (oldest), unchanged shape.
    expect(dto.agent).toEqual({ name: "Azriel", role: "Shadow-singer" });
    expect(dto.configuration.modelId).toBe("glm-5.3");
    expect(dto.agents[0].configuration.modelId).toBe("glm-5.3");
  });

  it("a freshly created house has exactly one agent and agents[0] === agent", () => {
    const db = getDb();
    const house = seedHouse();
    expect(house.agents).toHaveLength(1);
    expect(house.agents[0]).toMatchObject({
      name: house.agent.name,
      role: house.agent.role,
      configuration: house.configuration,
    });
  });
});

/* ================================================================== */
/* Service layer: High Lord guard + audit (Q9)                        */
/* ================================================================== */

describe("agent service guards + audit", () => {
  it("writes a create audit row attributed to the agent", () => {
    const db = getDb();
    const house = seedHouse();
    const agent = createAgentService(db, house.id, {
      name: "Cassian",
      role: "General",
      configuration: makeConfig(),
    });
    const entries = listAuditLog(db, { entityType: "agent" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "user",
      actorAgentId: agent.id,
      action: "create",
      entityType: "agent",
      entityId: agent.id,
    });
    expect(entries[0].metadata).toMatchObject({ houseId: house.id, name: "Cassian" });
  });

  it("writes update + delete audit rows for agent CRUD", () => {
    const db = getDb();
    const house = seedHouse();
    const agent = createAgentService(db, house.id, {
      name: "Cassian",
      role: "General",
      configuration: makeConfig(),
    });
    updateAgentService(db, house.id, agent.id, { configuration: { modelId: "m9" } });
    deleteAgentService(db, house.id, agent.id);

    const actions = listAuditLog(db, { entityType: "agent" }).map((e) => e.action).sort();
    expect(actions).toEqual(["create", "delete", "update"]);
  });

  it("allows updating the High Lord's existing agent (model edit) but keeps the roster fixed", () => {
    const db = getDb();
    const hl = seedHighLordHouse(db)!;
    const hlAgent = listAgentsForHouse(db, hl.id)[0];

    // The existing agent IS editable — name…
    const renamed = updateAgentService(db, hl.id, hlAgent.id, { name: "Y" });
    expect(renamed.id).toBe(hlAgent.id);
    expect(renamed.name).toBe("Y");

    // …and its model, which persists.
    const updated = updateAgentService(db, hl.id, hlAgent.id, {
      configuration: { modelId: "highlord-model" },
    });
    expect(updated.configuration.modelId).toBe("highlord-model");
    expect(listAgentsForHouse(db, hl.id)[0].configuration.modelId).toBe("highlord-model");
    expect(getHouse(db, hl.id)!.configuration.modelId).toBe("highlord-model");

    // …but the roster stays fixed: create/delete still throw.
    expect(() =>
      createAgentService(db, hl.id, { name: "X", role: "R", configuration: makeConfig() }),
    ).toThrow(HighLordTransitionError);
    expect(() => deleteAgentService(db, hl.id, hlAgent.id)).toThrow(HighLordTransitionError);
  });

  it("rejects switching the High Lord's agent to the Ollama runtime", () => {
    const db = getDb();
    const hl = seedHighLordHouse(db)!;
    const hlAgent = listAgentsForHouse(db, hl.id)[0];

    expect(() =>
      updateAgentService(db, hl.id, hlAgent.id, {
        configuration: { executionProvider: "ollama" },
      }),
    ).toThrow(HighLordTransitionError);
    // Unchanged on disk.
    expect(listAgentsForHouse(db, hl.id)[0].configuration.executionProvider).toBe("opencode");
  });

  it("service rejects deleting the last agent via LastAgentError", () => {
    const db = getDb();
    const house = seedHouse();
    const only = listAgentsForHouse(db, house.id)[0];
    expect(() => deleteAgentService(db, house.id, only.id)).toThrow(LastAgentError);
  });
});
