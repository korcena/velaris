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
import type { HouseDto, HouseStatus, HouseConfiguration, HouseAgent } from "@/shared/types";
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
  const patch = {
    name: parsed.name,
    description: parsed.description,
    agent: parsed.agent as Partial<HouseAgent> | undefined,
    configuration: parsed.configuration as Partial<HouseConfiguration> | undefined,
  };
  return repoUpdate(db, id, patch);
}

/** Validate & apply a status transition. */
export function transitionHouseStatusService(db: VelarisDb, id: string, to: HouseStatus): HouseDto {
  // Rule enforcement lives in the repo (canTransition) — the service is the
  // named entry point for the status route.
  return repoTransition(db, id, to);
}

/** Validate a transition without mutating (used for pre-flight checks in the UI). */
export function assertTransitionAllowed(from: HouseStatus, to: HouseStatus): boolean {
  return canTransition(from, to);
}

export function getHouseService(db: VelarisDb, id: string): HouseDto | null {
  return getHouse(db, id);
}

export function listHousesService(db: VelarisDb, includeArchived: boolean): HouseDto[] {
  return listHouses(db, { includeArchived });
}

/** Delete only when archived (repo enforces). */
export function deleteHouseService(db: VelarisDb, id: string): void {
  repoDelete(db, id);
}

export function houseHasTasksService(db: VelarisDb, id: string): boolean {
  return houseHasTasks(db, id);
}
