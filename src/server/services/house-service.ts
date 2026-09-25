/**
 * House service — zod-validates input at the boundary, then delegates to the
 * repository, enforcing status transition rules.
 */

import { randomUUID } from "node:crypto";
import type { VelarisDb } from "@/lib/db";
import {
  houseCreateSchema,
  houseUpdateSchema,
  type HouseCreateInput,
  type HouseUpdateInput,
} from "@/shared/schemas/house";
import type {
  HouseDto,
  HouseStatus,
  HouseConfiguration,
  HouseAgent,
} from "@/shared/types";
import {
  createHouse as repoCreate,
  updateHouse as repoUpdate,
  transitionHouseStatus as repoTransition,
  deleteHouse as repoDelete,
  getHouse,
  listHouses,
  houseHasTasks,
  canTransition,
  HouseNotFoundError,
  InvalidStatusTransitionError,
  HouseNotArchivedError,
} from "@/server/repositories/house-repo";

export {
  HouseNotFoundError,
  InvalidStatusTransitionError,
  HouseNotArchivedError,
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

/** Parse & create. Throws ZodError (→ 400) or repo errors (→ 409 handled in route). */
export function createHouseService(db: VelarisDb, input: unknown): HouseDto {
  const parsed = houseCreateSchema.parse(input); // ZodError bubble → route maps to 400
  return repoCreate(db, {
    id: randomUUID(),
    name: parsed.name,
    description: parsed.description ?? "",
    agent: parsed.agent as HouseAgent,
    configuration: parsed.configuration as HouseConfiguration,
  });
}

/** Parse & update; status provided via the nested patch would be ignored — use transitionHouseStatus. */
export function updateHouseService(db: VelarisDb, id: string, input: unknown): HouseDto {
  const parsed = houseUpdateSchema.parse(input);
  const configPatch = parsed.configuration as Partial<HouseConfiguration> | undefined;
  // Phase 5 decision Q9: the High Lord's planning + steering rely on OpenCode
  // (getSession/listMessages), so it must never run on the Ollama runtime. Reject
  // a PATCH that would set executionProvider='ollama' on a high_lord house with
  // 422. Only thrown when the patch would actually make that change.
  if (configPatch?.executionProvider === "ollama") {
    const existing = getHouse(db, id);
    if (existing?.kind === "high_lord") {
      throw new HighLordTransitionError(
        "The Court's planning session requires OpenCode — the High Lord cannot use the Ollama runtime",
      );
    }
  }
  const patch = {
    name: parsed.name,
    description: parsed.description,
    agent: parsed.agent as Partial<HouseAgent> | undefined,
    configuration: configPatch,
  };
  return repoUpdate(db, id, patch);
}

/** Validate & apply a status transition. */
export function transitionHouseStatusService(db: VelarisDb, id: string, to: HouseStatus): HouseDto {
  // Rule enforcement lives in the repo (canTransition) — the service is the
  // named entry point for the status route.
  guardHighLordTransition(db, id, to);
  return repoTransition(db, id, to);
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
}

export function houseHasTasksService(db: VelarisDb, id: string): boolean {
  return houseHasTasks(db, id);
}
