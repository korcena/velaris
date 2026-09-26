/**
 * House repository — CRUD + embedded agent/configuration upsert within a
 * transaction, plus guarded status transitions.
 *
 * Status transition rules (ARCHITECTURE §6.1):
 *   active ⇄ disabled
 *   active | disabled → archived
 *   archived is terminal
 *   DELETE only allowed when status === 'archived'
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import { rawDb } from "@/lib/db";
import { houses, agents, agentConfigurations } from "@/lib/db/schema";
import { parseJson } from "@/shared/schemas/common";
import { HIGH_LORD_SEED, DEFAULT_HOUSES } from "@/shared/constants";
import type {
  HouseDto,
  HouseStatus,
  HouseKind,
  Permissions,
  HouseAgent,
  HouseAgentDto,
  HouseConfiguration,
} from "@/shared/types";
import type { DefaultHouse } from "@/shared/constants";

/* ------------------------------ Errors ------------------------------ */

export class HouseNotFoundError extends Error {
  constructor(id: string) {
    super(`House not found: ${id}`);
    this.name = "HouseNotFoundError";
  }
}

export class InvalidStatusTransitionError extends Error {
  status: HouseStatus;

  constructor(from: HouseStatus, to: HouseStatus) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = "InvalidStatusTransitionError";
    this.status = to;
  }
}

export class HouseNotArchivedError extends Error {
  constructor(id: string) {
    super(`House must be archived before deletion: ${id}`);
    this.name = "HouseNotArchivedError";
  }
}

/* --------------------------- Agent errors (Phase 6 Stage B) ---------- */

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent not found: ${id}`);
    this.name = "AgentNotFoundError";
  }
}

/**
 * Refuses deletion of a house's ONLY agent: a house must always keep one agent
 * (the default used when `tasks.agent_id` is null). Mapped to 409.
 */
export class LastAgentError extends Error {
  constructor(houseId: string) {
    super(`Cannot delete the last agent of house ${houseId} — a house must keep one`);
    this.name = "LastAgentError";
  }
}

/* --------------------------- Transition rules ------------------------ */

const TRANSITIONS: Record<HouseStatus, HouseStatus[]> = {
  active: ["disabled", "archived"],
  disabled: ["active", "archived"],
  archived: [], // terminal
};

export function canTransition(from: HouseStatus, to: HouseStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Allow DELETE only when archived. */
export function canDelete(status: HouseStatus): boolean {
  return status === "archived";
}

/* ------------------------------ Mapping ------------------------------ */

const DEFAULT_CONFIGURATION: HouseConfiguration = {
  systemPrompt: "",
  executionProvider: "opencode",
  aiProvider: "ollama-cloud",
  modelId: "",
  workspaceAllowlist: [],
  tools: [],
  permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
  approvalPolicy: "always",
  concurrency: 1,
};

/** Map an agent_configurations row onto the shared HouseConfiguration shape. */
function configRowToDto(config: typeof agentConfigurations.$inferSelect | undefined): HouseConfiguration {
  if (!config) return { ...DEFAULT_CONFIGURATION };
  return {
    systemPrompt: config.systemPrompt,
    executionProvider: config.executionProvider as HouseConfiguration["executionProvider"],
    aiProvider: config.aiProvider,
    modelId: config.modelId,
    workspaceAllowlist: parseJson<string[]>(config.workspaceAllowlist, []),
    tools: parseJson<string[]>(config.tools, []),
    permissions: parseJson<Permissions>(config.permissions, {
      fileSystem: "ask",
      shell: "ask",
      network: "deny",
      git: "allow",
    }),
    approvalPolicy: config.approvalPolicy as HouseConfiguration["approvalPolicy"],
    concurrency: config.concurrency,
  };
}

/**
 * All agents for a house, OLDEST FIRST (the Phase 6 default-agent rule), each
 * with its single configuration. Always loads every agent (no `.limit(1)`) so
 * the DTO can expose `agents[]`.
 */
export function listAgentsForHouse(db: VelarisDb, houseId: string): HouseAgentDto[] {
  const agentRows = db
    .select()
    .from(agents)
    .where(eq(agents.houseId, houseId))
    // `created_at` is millisecond-resolution, so two agents created in the same
    // tick tie. Tie-break on `rowid` (monotonic INSERT order) rather than on the
    // random uuid `id`, which is not correlated with insertion order and can
    // silently invert the "oldest agent is the default" rule.
    .orderBy(agents.createdAt, sql`rowid`)
    .all();
  return agentRows.map((a) => {
    const config = db
      .select()
      .from(agentConfigurations)
      .where(eq(agentConfigurations.agentId, a.id))
      .limit(1)
      .get();
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      configuration: configRowToDto(config),
    };
  });
}

/**
 * The house default agent = the OLDEST agent (Phase 6 Q2), used whenever a
 * task's `agent_id` is null. Null when the house has no agent rows.
 */
export function resolveDefaultAgent(db: VelarisDb, houseId: string): HouseAgentDto | null {
  return listAgentsForHouse(db, houseId)[0] ?? null;
}

/**
 * Resolve the agent a task should run as (Phase 6 Stage B):
 *  - a set `task.agentId` that belongs to the house → that agent + its config;
 *  - otherwise the house default (oldest agent).
 * Returns null when the house has no agents at all (defensive).
 *
 * Single-agent behavior is preserved: with no `task.agentId` this returns the
 * same oldest/default agent the pre-multi-agent code used.
 */
export function resolveRuntimeAgent(
  db: VelarisDb,
  houseId: string,
  task: { agentId?: string | null },
): HouseAgentDto | null {
  const all = listAgentsForHouse(db, houseId);
  if (task.agentId) {
    const chosen = all.find((a) => a.id === task.agentId);
    if (chosen) return chosen;
  }
  return all[0] ?? null;
}

export function houseRowToDto(db: VelarisDb, houseId: string): HouseDto | null {
  const h = db.select().from(houses).where(eq(houses.id, houseId)).get();
  if (!h) return null;

  const agentsForHouse = listAgentsForHouse(db, houseId);

  // Backward-compatible singular agent = the default (oldest) agent.
  const defaultAgent = agentsForHouse[0];
  const agentDto: HouseAgent = defaultAgent
    ? { name: defaultAgent.name, role: defaultAgent.role }
    : { name: "", role: "" };
  const configuration: HouseConfiguration = defaultAgent
    ? defaultAgent.configuration
    : { ...DEFAULT_CONFIGURATION };

  return {
    id: h.id,
    name: h.name,
    description: h.description ?? "",
    kind: h.kind as HouseKind,
    status: h.status as HouseStatus,
    agent: agentDto,
    configuration,
    agents: agentsForHouse,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

/* ------------------------------ Reading ------------------------------ */

export function listHouses(
  db: VelarisDb,
  opts: { includeArchived?: boolean; includeHighLord?: boolean } = {},
): HouseDto[] {
  const rows = db
    .select()
    .from(houses)
    .all()
    // Sort newest-first for a stable grid; archive filter applied in memory for MVP.
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const archivedFiltered = opts.includeArchived
    ? rows
    : rows.filter((r) => (r.status as HouseStatus) !== "archived");

  // The seeded High Lord is excluded from the plain list to protect the Houses
  // grid empty-state assertions; includeHighLord opts in (used by the map).
  const filtered = opts.includeHighLord
    ? archivedFiltered
    : archivedFiltered.filter((r) => (r.kind as HouseKind) !== "high_lord");

  return filtered.map((r) => houseRowToDto(db, r.id)!);
}

export function getHouse(db: VelarisDb, id: string): HouseDto | null {
  return houseRowToDto(db, id);
}

/** The single High Lord house (kind='high_lord'), or null. Used by the Court. */
export function findHighLordHouse(db: VelarisDb): HouseDto | null {
  const row = db.select().from(houses).where(eq(houses.kind, "high_lord")).limit(1).get();
  return row ? houseRowToDto(db, row.id) : null;
}

/* ------------------------------ Writing ------------------------------ */

export interface CreateHouseInput {
  id?: string;
  name: string;
  description?: string | null;
  kind?: HouseKind;
  agent: HouseAgent;
  configuration: HouseConfiguration;
  status?: HouseStatus;
}

/**
 * Create a house with its agent and configuration in one transaction.
 * If an id is supplied (used by the service for explicit uuid), it is honoured.
 */
export function createHouse(db: VelarisDb, input: CreateHouseInput): HouseDto {
  const houseId = input.id ?? randomUUID();
  const agentId = randomUUID();
  const configId = randomUUID();
  const status = input.status ?? "active";

  db.transaction((tx) => {
    tx.insert(houses)
      .values({
        id: houseId,
        name: input.name,
        description: input.description ?? "",
        kind: input.kind ?? "agent",
        status,
      })
      .run();

    tx.insert(agents)
      .values({
        id: agentId,
        houseId,
        name: input.agent.name,
        role: input.agent.role,
      })
      .run();

    tx.insert(agentConfigurations)
      .values({
        id: configId,
        agentId,
        systemPrompt: input.configuration.systemPrompt,
        executionProvider: input.configuration.executionProvider,
        aiProvider: input.configuration.aiProvider,
        modelId: input.configuration.modelId,
        workspaceAllowlist: JSON.stringify(input.configuration.workspaceAllowlist ?? []),
        tools: JSON.stringify(input.configuration.tools ?? []),
        permissions: JSON.stringify(input.configuration.permissions ?? {}),
        approvalPolicy: input.configuration.approvalPolicy,
        concurrency: input.configuration.concurrency,
      })
      .run();
  });

  return houseRowToDto(db, houseId)!;
}

export type UpdateHousePatch = {
  name?: string;
  description?: string | null;
  agent?: Partial<HouseAgent>;
  configuration?: Partial<HouseConfiguration>;
};

/** Merge partial updates onto the existing house + agent + config in one tx. */
export function updateHouse(db: VelarisDb, id: string, patch: UpdateHousePatch): HouseDto {
  const houseId = id;
  const existing = houseRowToDto(db, houseId);
  if (!existing) throw new HouseNotFoundError(id);

  db.transaction((tx) => {
    const update: Record<string, unknown> = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.description !== undefined) update.description = patch.description ?? "";
    if (Object.keys(update).length) {
      update.updatedAt = new Date().toISOString();
      tx.update(houses).set(update).where(eq(houses.id, houseId)).run();
    }

    const agent = tx
      .select()
      .from(agents)
      .where(eq(agents.houseId, houseId))
      // Same rowid tie-break as listAgentsForHouse: the DEFAULT agent must be
      // the one inserted first even when created_at ties.
      .orderBy(agents.createdAt, sql`rowid`)
      .limit(1)
      .get();

    if (agent && patch.agent) {
      const aUpdate: Record<string, unknown> = {};
      if (patch.agent.name !== undefined) aUpdate.name = patch.agent.name;
      if (patch.agent.role !== undefined) aUpdate.role = patch.agent.role;
      if (Object.keys(aUpdate).length) {
        aUpdate.updatedAt = new Date().toISOString();
        tx.update(agents).set(aUpdate).where(eq(agents.id, agent.id)).run();
      }
    }

    const config = agent
      ? tx
          .select()
          .from(agentConfigurations)
          .where(eq(agentConfigurations.agentId, agent.id))
          .limit(1)
          .get()
      : undefined;

    if (config && patch.configuration) {
      const cUpdate: Record<string, unknown> = {};
      const p = patch.configuration;
      if (p.systemPrompt !== undefined) cUpdate.systemPrompt = p.systemPrompt;
      if (p.executionProvider !== undefined) cUpdate.executionProvider = p.executionProvider;
      if (p.aiProvider !== undefined) cUpdate.aiProvider = p.aiProvider;
      if (p.modelId !== undefined) cUpdate.modelId = p.modelId;
      if (p.workspaceAllowlist !== undefined)
        cUpdate.workspaceAllowlist = JSON.stringify(p.workspaceAllowlist);
      if (p.tools !== undefined) cUpdate.tools = JSON.stringify(p.tools);
      if (p.permissions !== undefined) cUpdate.permissions = JSON.stringify(p.permissions);
      if (p.approvalPolicy !== undefined) cUpdate.approvalPolicy = p.approvalPolicy;
      if (p.concurrency !== undefined) cUpdate.concurrency = p.concurrency;
      if (Object.keys(cUpdate).length) {
        cUpdate.updatedAt = new Date().toISOString();
        tx.update(agentConfigurations).set(cUpdate).where(eq(agentConfigurations.id, config.id)).run();
      }
    }
  });

  return houseRowToDto(db, houseId)!;
}

/** Transition a house to a new status with rules enforced. */
export function transitionHouseStatus(
  db: VelarisDb,
  id: string,
  to: HouseStatus,
): HouseDto {
  const row = db.select().from(houses).where(eq(houses.id, id)).get();
  if (!row) throw new HouseNotFoundError(id);

  const from = row.status as HouseStatus;
  if (!canTransition(from, to)) {
    throw new InvalidStatusTransitionError(from, to);
  }

  db.update(houses)
    .set({ status: to, updatedAt: new Date().toISOString() })
    .where(eq(houses.id, id))
    .run();

  return houseRowToDto(db, id)!;
}

/** Delete only when archived. Throws HouseNotArchivedError otherwise. */
export function deleteHouse(db: VelarisDb, id: string): void {
  const row = db.select().from(houses).where(eq(houses.id, id)).get();
  if (!row) throw new HouseNotFoundError(id);

  if (!canDelete(row.status as HouseStatus)) {
    throw new HouseNotArchivedError(id);
  }

  db.delete(houses).where(eq(houses.id, id)).run();
}

/* ------------------------ Agent CRUD (Phase 6) ---------------------- */

export interface CreateAgentInput {
  id?: string;
  name: string;
  role: string;
  configuration: HouseConfiguration;
}

function assertHouseExists(db: VelarisDb, houseId: string): void {
  const row = db.select({ id: houses.id }).from(houses).where(eq(houses.id, houseId)).get();
  if (!row) throw new HouseNotFoundError(houseId);
}

/**
 * Create a standalone agent + its single configuration under a house, in one
 * transaction. The unique `idx_agent_configurations_agent` index stays intact
 * because every agent gets exactly one config row.
 */
export function createAgent(
  db: VelarisDb,
  houseId: string,
  input: CreateAgentInput,
): HouseAgentDto {
  assertHouseExists(db, houseId);
  const agentId = input.id ?? randomUUID();
  const configId = randomUUID();

  db.transaction((tx) => {
    tx.insert(agents)
      .values({ id: agentId, houseId, name: input.name, role: input.role })
      .run();
    tx.insert(agentConfigurations)
      .values({
        id: configId,
        agentId,
        systemPrompt: input.configuration.systemPrompt,
        executionProvider: input.configuration.executionProvider,
        aiProvider: input.configuration.aiProvider,
        modelId: input.configuration.modelId,
        workspaceAllowlist: JSON.stringify(input.configuration.workspaceAllowlist ?? []),
        tools: JSON.stringify(input.configuration.tools ?? []),
        permissions: JSON.stringify(input.configuration.permissions ?? {}),
        approvalPolicy: input.configuration.approvalPolicy,
        concurrency: input.configuration.concurrency,
      })
      .run();
  });

  const created = listAgentsForHouse(db, houseId).find((a) => a.id === agentId);
  if (!created) throw new AgentNotFoundError(agentId);
  return created;
}

export function getAgent(db: VelarisDb, agentId: string): HouseAgentDto | null {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent) return null;
  const config = db
    .select()
    .from(agentConfigurations)
    .where(eq(agentConfigurations.agentId, agent.id))
    .limit(1)
    .get();
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    configuration: configRowToDto(config),
  };
}

export type UpdateAgentPatch = {
  name?: string;
  role?: string;
  configuration?: Partial<HouseConfiguration>;
};

/** Merge a partial patch onto an agent + its config in one transaction. */
export function updateAgent(
  db: VelarisDb,
  agentId: string,
  patch: UpdateAgentPatch,
): HouseAgentDto {
  const existing = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!existing) throw new AgentNotFoundError(agentId);

  db.transaction((tx) => {
    const aUpdate: Record<string, unknown> = {};
    if (patch.name !== undefined) aUpdate.name = patch.name;
    if (patch.role !== undefined) aUpdate.role = patch.role;
    if (Object.keys(aUpdate).length) {
      aUpdate.updatedAt = new Date().toISOString();
      tx.update(agents).set(aUpdate).where(eq(agents.id, agentId)).run();
    }

    const config = tx
      .select()
      .from(agentConfigurations)
      .where(eq(agentConfigurations.agentId, agentId))
      .limit(1)
      .get();

    if (config && patch.configuration) {
      const p = patch.configuration;
      const cUpdate: Record<string, unknown> = {};
      if (p.systemPrompt !== undefined) cUpdate.systemPrompt = p.systemPrompt;
      if (p.executionProvider !== undefined) cUpdate.executionProvider = p.executionProvider;
      if (p.aiProvider !== undefined) cUpdate.aiProvider = p.aiProvider;
      if (p.modelId !== undefined) cUpdate.modelId = p.modelId;
      if (p.workspaceAllowlist !== undefined)
        cUpdate.workspaceAllowlist = JSON.stringify(p.workspaceAllowlist);
      if (p.tools !== undefined) cUpdate.tools = JSON.stringify(p.tools);
      if (p.permissions !== undefined) cUpdate.permissions = JSON.stringify(p.permissions);
      if (p.approvalPolicy !== undefined) cUpdate.approvalPolicy = p.approvalPolicy;
      if (p.concurrency !== undefined) cUpdate.concurrency = p.concurrency;
      if (Object.keys(cUpdate).length) {
        cUpdate.updatedAt = new Date().toISOString();
        tx.update(agentConfigurations)
          .set(cUpdate)
          .where(eq(agentConfigurations.id, config.id))
          .run();
      }
    }
  });

  const updated = getAgent(db, agentId);
  if (!updated) throw new AgentNotFoundError(agentId);
  return updated;
}

/**
 * Delete an agent. Rules:
 *  - unknown id → AgentNotFoundError (404);
 *  - the house's LAST agent → LastAgentError (409) — a house must always keep
 *    one agent so the null-`agent_id` default path is never broken;
 *  - otherwise delete (cascades the config; `tasks.agent_id` SET NULLs).
 */
export function deleteAgent(db: VelarisDb, agentId: string): void {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent) throw new AgentNotFoundError(agentId);

  const countRow = rawDb(db)
    .prepare(`SELECT COUNT(*) AS c FROM agents WHERE house_id = ?`)
    .get(agent.houseId) as { c: number };
  if (countRow.c <= 1) throw new LastAgentError(agent.houseId);

  db.delete(agents).where(eq(agents.id, agentId)).run();
}

/** Whether an agent belongs to a given house (task-routing validation). */
export function agentBelongsToHouse(db: VelarisDb, agentId: string, houseId: string): boolean {
  const row = db
    .select({ id: agents.id })
    .from(agents)
    .where(sql`${agents.id} = ${agentId} AND ${agents.houseId} = ${houseId}`)
    .get();
  return !!row;
}

/* ------------------------- Query helpers ---------------------------- */

/** Whether any tasks reference this house (blocking guard for DELETE). */
export function houseHasTasks(db: VelarisDb, id: string): boolean {
  const row = rawDb(db)
    .prepare(`SELECT EXISTS(SELECT 1 FROM tasks WHERE house_id = ?) AS e`)
    .get(id) as { e: 0 | 1 };
  return row.e === 1;
}

/* ------------------------- High Lord seeding ------------------------ */

/**
 * Idempotent seed of the High Lord house (kind='high_lord'): a singleton house
 * row with its agent + configuration, created only when no High Lord exists.
 * Never clobbers user edits (model/provider/systemPrompt are user-editable via
 * the standard house form). Reuses the createHouse repo fn inside a transaction.
 *
 * Accepts either the Drizzle wrapper or the raw better-sqlite3 connection so it
 * can run from both the web process bootstrap and the (raw) engine process —
 * mirroring seedDefaultProviderConfigs.
 */
export function seedHighLordHouse(
  db: VelarisDb | Database.Database,
): HouseDto | null {
  const raw: Database.Database =
    "$client" in db ? rawDb(db as VelarisDb) : (db as Database.Database);

  const houseId = randomUUID();
  const agentId = randomUUID();
  const configId = randomUUID();
  const config = HIGH_LORD_SEED.CONFIGURATION;

  // Check+insert run inside one IMMEDIATE transaction (symmetric with
  // seedDefaultHouses / seedDefaultTemplates) so concurrent web + engine first
  // boots cannot both pass the existence check and insert two High Lords. The
  // write lock is taken up front; busy_timeout=5000 is already set on the
  // connection. Idempotent by kind='high_lord' — never clobbers user edits.
  const { id } = raw
    .transaction(() => {
      const existing = raw
        .prepare(`SELECT id FROM houses WHERE kind = 'high_lord' LIMIT 1`)
        .get() as { id: string } | undefined;
      if (existing) return { id: existing.id };

      raw
        .prepare(
          `INSERT INTO houses (id, name, description, kind, status, created_at, updated_at)
           VALUES (?, ?, ?, 'high_lord', 'active', ?, ?)`,
        )
        .run(
          houseId,
          HIGH_LORD_SEED.HOUSE_NAME,
          HIGH_LORD_SEED.HOUSE_DESCRIPTION,
          new Date().toISOString(),
          new Date().toISOString(),
        );
      raw
        .prepare(
          `INSERT INTO agents (id, house_id, name, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          agentId,
          houseId,
          HIGH_LORD_SEED.AGENT_NAME,
          HIGH_LORD_SEED.AGENT_ROLE,
          new Date().toISOString(),
          new Date().toISOString(),
        );
      raw
        .prepare(
          `INSERT INTO agent_configurations
             (id, agent_id, system_prompt, execution_provider, ai_provider, model_id,
              workspace_allowlist, tools, permissions, approval_policy, concurrency, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '{}', ?, ?, ?, ?)`,
        )
        .run(
          configId,
          agentId,
          HIGH_LORD_SEED.SYSTEM_PROMPT,
          config.executionProvider,
          config.aiProvider,
          config.modelId,
          config.approvalPolicy,
          config.concurrency,
          new Date().toISOString(),
          new Date().toISOString(),
        );

      return { id: houseId };
    })
    .immediate();

  return "$client" in db ? houseRowToDto(db as VelarisDb, id) : null;
}

/* ------------------------ Default houses (ACOTAR) ------------------- */

/**
 * Insert one default house + its agent + its configuration as raw prepared
 * INSERTs (mirrors seedHighLordHouse). `kind='agent'`, `status='active'`, and
 * all JSON columns stringified exactly as `createHouse` does. No audit: this is
 * a boot seed, not a user action.
 */
function insertDefaultHouse(raw: Database.Database, entry: DefaultHouse): void {
  const houseId = randomUUID();
  const agentId = randomUUID();
  const configId = randomUUID();
  const now = new Date().toISOString();
  const config = entry.configuration;

  raw
    .prepare(
      `INSERT INTO houses (id, name, description, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'agent', 'active', ?, ?)`,
    )
    .run(houseId, entry.house.name, entry.house.description, now, now);

  raw
    .prepare(
      `INSERT INTO agents (id, house_id, name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(agentId, houseId, entry.agent.name, entry.agent.role, now, now);

  raw
    .prepare(
      `INSERT INTO agent_configurations
         (id, agent_id, system_prompt, execution_provider, ai_provider, model_id,
          workspace_allowlist, tools, permissions, approval_policy, concurrency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      configId,
      agentId,
      config.systemPrompt,
      config.executionProvider,
      config.aiProvider,
      config.modelId,
      JSON.stringify(config.workspaceAllowlist ?? []),
      JSON.stringify(config.tools ?? []),
      JSON.stringify(config.permissions ?? {}),
      config.approvalPolicy,
      config.concurrency,
      now,
      now,
    );
}

/**
 * Idempotent, no-clobber seed of the ten default ACOTAR houses — one agent and
 * one complete configuration each. A default is inserted only when NO house row
 * (any kind/status) already has that exact name; an existing same-named house is
 * skipped untouched (never renamed, merged, or deleted). Returns the number
 * inserted.
 *
 * Matching is by EXACT name, so renaming a seeded house makes its original
 * default name look absent: the next boot re-creates the default, leaving the
 * renamed house AND a fresh default. Reconfiguring a seeded house in place is
 * preserved (its name is unchanged, so the default stays skipped). Documented
 * behaviour; no seed marker is used (the frozen design forbids a schema change).
 *
 * Each entry's existence check + insert runs inside an IMMEDIATE transaction so
 * concurrent web + engine boots cannot both pass the check and double-insert
 * (the write lock is taken up front; busy_timeout=5000 is already set on the
 * connection). Accepts either the Drizzle wrapper or the raw connection, like
 * seedHighLordHouse, so both processes share one code path.
 */
export function seedDefaultHouses(db: VelarisDb | Database.Database): number {
  const raw: Database.Database =
    "$client" in db ? rawDb(db as VelarisDb) : (db as Database.Database);

  const exists = raw.prepare(`SELECT id FROM houses WHERE name = ? LIMIT 1`);

  let inserted = 0;
  for (const entry of DEFAULT_HOUSES) {
    const didInsert = raw
      .transaction(() => {
        if (exists.get(entry.house.name)) return false;
        insertDefaultHouse(raw, entry);
        return true;
      })
      .immediate();
    if (didInsert) inserted += 1;
  }
  return inserted;
}

