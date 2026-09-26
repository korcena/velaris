/**
 * House service — zod-validates input at the boundary, then delegates to the
 * repository, enforcing status transition rules.
 */

import { randomUUID } from "node:crypto";
import type { VelarisDb } from "@/lib/db";
import {
  houseCreateSchema,
  houseUpdateSchema,
  houseAgentCreateSchema,
  houseAgentUpdateSchema,
} from "@/shared/schemas/house";
import type {
  HouseDto,
  HouseStatus,
  HouseConfiguration,
  HouseAgent,
  HouseAgentDto,
} from "@/shared/types";
import {
  createHouse as repoCreate,
  updateHouse as repoUpdate,
  transitionHouseStatus as repoTransition,
  deleteHouse as repoDelete,
  getHouse,
  listHouses,
  createAgent as repoCreateAgent,
  getAgent as repoGetAgent,
  updateAgent as repoUpdateAgent,
  deleteAgent as repoDeleteAgent,
  listAgentsForHouse,
  houseHasTasks,
  canTransition,
  HouseNotFoundError,
  InvalidStatusTransitionError,
  HouseNotArchivedError,
  AgentNotFoundError,
  LastAgentError,
} from "@/server/repositories/house-repo";
import { recordAudit } from "@/server/repositories/audit-repo";

export {
  HouseNotFoundError,
  InvalidStatusTransitionError,
  HouseNotArchivedError,
  AgentNotFoundError,
  LastAgentError,
};

/**
 * The High Lord house is a singleton orchestrator that must not be disabled,
 * archived or deleted via the API (addendum D1). Thrown in the service layer
 * (web-write boundary) and mapped to 422 via `badTransition` in api-helpers.
 */
export class HighLordTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HighLordTransitionError";
  }
}

/**
 * Reject switching a `high_lord` house's configuration (or its agent's) to the
 * Ollama runtime (Phase 5 Q9): the Court's planning + steering require OpenCode
 * (`getSession`/`listMessages`). No-op unless the caller is actually setting
 * `executionProvider='ollama'`.
 */
function rejectHighLordOllama(
  db: VelarisDb,
  houseId: string,
  executionProvider: unknown,
): void {
  if (executionProvider !== "ollama") return;
  if (getHouse(db, houseId)?.kind === "high_lord") {
    throw new HighLordTransitionError(
      "The Court's planning session requires OpenCode — the High Lord cannot use the Ollama runtime",
    );
  }
}

/** Parse & create. Throws ZodError (→ 400) or repo errors (→ 409 handled in route). */
export function createHouseService(db: VelarisDb, input: unknown): HouseDto {
  const parsed = houseCreateSchema.parse(input); // ZodError bubble → route maps to 400
  const house = repoCreate(db, {
    id: randomUUID(),
    name: parsed.name,
    description: parsed.description ?? "",
    agent: parsed.agent as HouseAgent,
    configuration: parsed.configuration as HouseConfiguration,
  });
  // Audit after the write succeeds; fire-and-forget so auditing never breaks
  // the user action (Q9: web user-action rows only).
  recordAudit(db, {
    actor: "user",
    action: "create",
    entityType: "house",
    entityId: house.id,
    metadata: { name: house.name, kind: house.kind },
  });
  return house;
}

/** Parse & update; status provided via the nested patch would be ignored — use transitionHouseStatus. */
export function updateHouseService(db: VelarisDb, id: string, input: unknown): HouseDto {
  const parsed = houseUpdateSchema.parse(input);
  const configPatch = parsed.configuration as Partial<HouseConfiguration> | undefined;
  // Phase 5 decision Q9: the High Lord's planning + steering rely on OpenCode
  // (getSession/listMessages), so it must never run on the Ollama runtime. Reject
  // a PATCH that would set executionProvider='ollama' on a high_lord house with
  // 422. Only thrown when the patch would actually make that change.
  rejectHighLordOllama(db, id, configPatch?.executionProvider);
  const patch = {
    name: parsed.name,
    description: parsed.description,
    agent: parsed.agent as Partial<HouseAgent> | undefined,
    configuration: configPatch,
  };
  const house = repoUpdate(db, id, patch);
  // Record which top-level fields changed (plus nested keys) without storing
  // the new values — the audit log is an index, not a content mirror.
  const changed = [
    ...(parsed.name !== undefined ? ["name"] : []),
    ...(parsed.description !== undefined ? ["description"] : []),
    ...(parsed.agent !== undefined ? ["agent"] : []),
    ...(configPatch !== undefined
      ? ["configuration", ...Object.keys(configPatch).map((k) => `configuration.${k}`)]
      : []),
  ];
  recordAudit(db, {
    actor: "user",
    action: "update",
    entityType: "house",
    entityId: house.id,
    metadata: { changed },
  });
  return house;
}

/** Validate & apply a status transition. */
export function transitionHouseStatusService(db: VelarisDb, id: string, to: HouseStatus): HouseDto {
  // Rule enforcement lives in the repo (canTransition) — the service is the
  // named entry point for the status route.
  guardHighLordTransition(db, id, to);
  const house = repoTransition(db, id, to);
  recordAudit(db, {
    actor: "user",
    action: "status",
    entityType: "house",
    entityId: house.id,
    metadata: { status: house.status },
  });
  return house;
}

/** The High Lord must stay active (addendum D1) — only `active` ⇄ `active` (no-op) escapes. */
function guardHighLordTransition(db: VelarisDb, id: string, to: HouseStatus): void {
  const house = getHouse(db, id);
  if (house?.kind === "high_lord" && to !== "active") {
    throw new HighLordTransitionError(
      "The High Lord house cannot be disabled or archived — it is Velaris' orchestrator",
    );
  }
}

/** Validate a transition without mutating (used for pre-flight checks in the UI). */
export function assertTransitionAllowed(from: HouseStatus, to: HouseStatus): boolean {
  return canTransition(from, to);
}

export function getHouseService(db: VelarisDb, id: string): HouseDto | null {
  return getHouse(db, id);
}

export function listHousesService(
  db: VelarisDb,
  includeArchived: boolean,
  includeHighLord = false,
): HouseDto[] {
  return listHouses(db, { includeArchived, includeHighLord });
}

/** Delete only when archived (repo enforces); the High Lord is never deletable. */
export function deleteHouseService(db: VelarisDb, id: string): void {
  const house = getHouse(db, id);
  if (house?.kind === "high_lord") {
    throw new HighLordTransitionError(
      "The High Lord house cannot be deleted — it is Velaris' orchestrator",
    );
  }
  repoDelete(db, id);
  recordAudit(db, {
    actor: "user",
    action: "delete",
    entityType: "house",
    entityId: house?.id ?? id,
    metadata: { name: house?.name ?? null },
  });
}

export function houseHasTasksService(db: VelarisDb, id: string): boolean {
  return houseHasTasks(db, id);
}

/* ---------------------- Agent CRUD (Phase 6 Stage B) ---------------- */

/**
 * The High Lord's agent ROSTER is fixed to its single orchestrator (Rhysand):
 * the house is a seeded singleton, so agents cannot be added to or removed
 * from it. The existing agent stays editable (model/name/role) via
 * `updateAgentService`; only `executionProvider='ollama'` is rejected there,
 * because the Court depends on that agent's OpenCode planning path. Rejects
 * create/delete on a high_lord house (422 via HighLordTransitionError),
 * mirroring the house-level guard.
 */
function guardHighLordRoster(db: VelarisDb, houseId: string): void {
  const house = getHouse(db, houseId);
  if (!house) throw new HouseNotFoundError(houseId);
  if (house.kind === "high_lord") {
    throw new HighLordTransitionError(
      "The High Lord house's agent roster is fixed — it cannot be changed",
    );
  }
}

export function listAgentsService(db: VelarisDb, houseId: string): HouseAgentDto[] | null {
  if (!getHouse(db, houseId)) return null;
  return listAgentsForHouse(db, houseId);
}

export function createAgentService(
  db: VelarisDb,
  houseId: string,
  input: unknown,
): HouseAgentDto {
  const parsed = houseAgentCreateSchema.parse(input);
  guardHighLordRoster(db, houseId);
  const agent = repoCreateAgent(db, houseId, {
    name: parsed.name,
    role: parsed.role,
    configuration: parsed.configuration as HouseConfiguration,
  });
  // Q9: audit agent CRUD as a web user-action row. actor_agent_id attributes the
  // action to the created agent; entityId is the agent (entity_type='agent').
  recordAudit(db, {
    actor: "user",
    actorAgentId: agent.id,
    action: "create",
    entityType: "agent",
    entityId: agent.id,
    metadata: { houseId, name: agent.name, role: agent.role },
  });
  return agent;
}

export function updateAgentService(
  db: VelarisDb,
  houseId: string,
  agentId: string,
  input: unknown,
): HouseAgentDto {
  const parsed = houseAgentUpdateSchema.parse(input);
  // The High Lord's existing agent is editable, but its Court planning path
  // requires OpenCode: reject a patch that would switch it to the Ollama
  // runtime (mirrors updateHouseService). Only thrown when the patch actually
  // sets executionProvider='ollama'.
  const configPatch = parsed.configuration as Partial<HouseConfiguration> | undefined;
  rejectHighLordOllama(db, houseId, configPatch?.executionProvider);
  // Ensure the agent exists AND belongs to this house (prevents cross-house
  // mutation via a mismatched path).
  const existing = repoGetAgent(db, agentId);
  if (!existing || !listAgentsForHouse(db, houseId).some((a) => a.id === agentId)) {
    throw new AgentNotFoundError(agentId);
  }
  const agent = repoUpdateAgent(db, agentId, {
    name: parsed.name,
    role: parsed.role,
    configuration: parsed.configuration as Partial<HouseConfiguration> | undefined,
  });
  const changed = [
    ...(parsed.name !== undefined ? ["name"] : []),
    ...(parsed.role !== undefined ? ["role"] : []),
    ...(parsed.configuration !== undefined
      ? ["configuration", ...Object.keys(parsed.configuration).map((k) => `configuration.${k}`)]
      : []),
  ];
  recordAudit(db, {
    actor: "user",
    actorAgentId: agent.id,
    action: "update",
    entityType: "agent",
    entityId: agent.id,
    metadata: { houseId, changed },
  });
  return agent;
}

export function deleteAgentService(db: VelarisDb, houseId: string, agentId: string): void {
  guardHighLordRoster(db, houseId);
  const existing = repoGetAgent(db, agentId);
  if (!existing || !listAgentsForHouse(db, houseId).some((a) => a.id === agentId)) {
    throw new AgentNotFoundError(agentId);
  }
  repoDeleteAgent(db, agentId);
  recordAudit(db, {
    actor: "user",
    action: "delete",
    entityType: "agent",
    entityId: agentId,
    metadata: { houseId, name: existing.name, role: existing.role },
  });
}
