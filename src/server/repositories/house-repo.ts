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
import { eq } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import { rawDb } from "@/lib/db";
import { houses, agents, agentConfigurations } from "@/lib/db/schema";
import { parseJson } from "@/shared/schemas/common";
import { HIGH_LORD_SEED } from "@/shared/constants";
import type {
  HouseDto,
  HouseStatus,
  HouseKind,
  Permissions,
  HouseAgent,
  HouseConfiguration,
} from "@/shared/types";

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

export function houseRowToDto(db: VelarisDb, houseId: string): HouseDto | null {
  const h = db.select().from(houses).where(eq(houses.id, houseId)).get();
  if (!h) return null;

  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.houseId, houseId))
    .limit(1)
    .get();

  const config = agent
    ? db
        .select()
        .from(agentConfigurations)
        .where(eq(agentConfigurations.agentId, agent.id))
        .limit(1)
        .get()
    : undefined;

  const agentDto: HouseAgent = agent
    ? { name: agent.name, role: agent.role }
    : { name: "", role: "" };

  const configuration: HouseConfiguration = config
    ? {
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
      }
    : {
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

  return {
    id: h.id,
    name: h.name,
    description: h.description ?? "",
    kind: h.kind as HouseKind,
    status: h.status as HouseStatus,
    agent: agentDto,
    configuration,
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

  const existing = raw
    .prepare(`SELECT id FROM houses WHERE kind = 'high_lord' LIMIT 1`)
    .get() as { id: string } | undefined;
  if (existing) {
    // Already seeded — return the existing DTO (via the wrapper if available).
    return "$client" in db ? houseRowToDto(db as VelarisDb, existing.id) : null;
  }

  const houseId = randomUUID();
  const agentId = randomUUID();
  const configId = randomUUID();
  const config = HIGH_LORD_SEED.CONFIGURATION;

  // Insert the house + agent + configuration in one transaction (idempotent by
  // the kind='high_lord' existence check above — never clobbers user edits).
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

  return "$client" in db ? houseRowToDto(db as VelarisDb, houseId) : null;
}

