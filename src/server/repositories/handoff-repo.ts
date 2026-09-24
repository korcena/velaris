/**
 * Handoff repository — rows recording a High Lord → executor delegation.
 *
 * One handoff row per subtask, created at delegation time. Keyed by house ids
 * (MVP: 1 house = 1 agent); source_house_id is normally the High Lord,
 * destination_house_id the executor. destination is nullable on delete so
 * history survives a house being archived+deleted.
 *
 * WRITE DISCIPLINE: the ENGINE creates handoff rows (delegation time). The web
 * process only reads them to serve the Court plan DTO.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import { handoffs, type HandoffRow } from "@/lib/db/schema";
import { parseJson } from "@/shared/schemas/common";
import type { HandoffDto } from "@/shared/types";

/* ------------------------------ Mapping ------------------------------ */

export function handoffRowToDto(row: HandoffRow): HandoffDto {
  return {
    id: row.id,
    subtaskId: row.subtaskId,
    sourceHouseId: row.sourceHouseId ?? null,
    destinationHouseId: row.destinationHouseId ?? null,
    instructions: row.instructions,
    context: parseJson<Record<string, unknown>>(row.context, {}),
    artifacts: parseJson<string[]>(row.artifacts, []),
    completionRequirements: row.completionRequirements,
    createdAt: row.createdAt,
  };
}

/* ------------------------------ Create ------------------------------ */

export interface CreateHandoffInput {
  id?: string;
  parentTaskId: string;
  subtaskId: string;
  sourceHouseId?: string | null;
  destinationHouseId: string;
  instructions?: string;
  context?: Record<string, unknown>;
  artifacts?: string[];
  completionRequirements?: string;
}

export function createHandoff(db: VelarisDb, input: CreateHandoffInput): HandoffDto {
  const id = input.id ?? randomUUID();
  db.insert(handoffs)
    .values({
      id,
      parentTaskId: input.parentTaskId,
      subtaskId: input.subtaskId,
      sourceHouseId: input.sourceHouseId ?? null,
      destinationHouseId: input.destinationHouseId,
      instructions: input.instructions ?? "",
      context: JSON.stringify(input.context ?? {}),
      artifacts: JSON.stringify(input.artifacts ?? []),
      completionRequirements: input.completionRequirements ?? "",
    })
    .run();
  return getHandoff(db, id)!;
}

/* ------------------------------ Reading ------------------------------ */

export function getHandoff(db: VelarisDb, id: string): HandoffDto | null {
  const row = db.select().from(handoffs).where(eq(handoffs.id, id)).get();
  return row ? handoffRowToDto(row) : null;
}

export function listHandoffsForParent(db: VelarisDb, parentId: string): HandoffDto[] {
  return db
    .select()
    .from(handoffs)
    .where(eq(handoffs.parentTaskId, parentId))
    .orderBy(handoffs.createdAt)
    .all()
    .map(handoffRowToDto);
}

export function listHandoffsForSubtask(db: VelarisDb, subtaskId: string): HandoffDto[] {
  return db
    .select()
    .from(handoffs)
    .where(eq(handoffs.subtaskId, subtaskId))
    .all()
    .map(handoffRowToDto);
}
