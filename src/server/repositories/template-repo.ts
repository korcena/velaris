/**
 * Template repository (Phase 6 Stage C) — CRUD for reusable house/project
 * templates with an idempotent seed of the defaults.
 *
 * Seeded templates (`is_seeded=1`) are IMMUTABLE: update/delete throw
 * `SeededTemplateError` so the boot seed can never be clobbered and the
 * defaults stay reproducible. User-created templates are freely editable.
 *
 * The payload is stored as JSON text (mirrors tasks.execution_preferences /
 * provider_configs.extra) and validated at the service boundary against the
 * shared house/project schemas. Accepts either the Drizzle wrapper or the raw
 * better-sqlite3 connection for the seed, so web bootstrap and the engine boot
 * can both call it (mirrors seedDefaultProviderConfigs / seedHighLordHouse).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import { rawDb } from "@/lib/db";
import { templates } from "@/lib/db/schema";
import { DEFAULT_TEMPLATES } from "@/shared/constants";
import { parseJson } from "@/shared/schemas/common";
import type {
  TemplateDto,
  TemplateKind,
  HouseTemplatePayload,
  ProjectTemplatePayload,
} from "@/shared/types";

/* ------------------------------ Errors ------------------------------ */

export class TemplateNotFoundError extends Error {
  constructor(id: string) {
    super(`Template not found: ${id}`);
    this.name = "TemplateNotFoundError";
  }
}

/** A seeded default cannot be edited or deleted. Mapped to 409. */
export class SeededTemplateError extends Error {
  constructor(id: string) {
    super(`Seeded template is immutable: ${id}`);
    this.name = "SeededTemplateError";
  }
}

/** A template with the same (kind, name) already exists. Mapped to 409. */
export class TemplateNameExistsError extends Error {
  constructor(kind: TemplateKind, name: string) {
    super(`A ${kind} template named '${name}' already exists`);
    this.name = "TemplateNameExistsError";
  }
}

/* ------------------------------ Mapping ----------------------------- */

export function templateRowToDto(row: typeof templates.$inferSelect): TemplateDto {
  return {
    id: row.id,
    kind: row.kind as TemplateKind,
    name: row.name,
    description: row.description,
    payload: parseJson<HouseTemplatePayload | ProjectTemplatePayload>(row.payload, {
      description: "",
    } as ProjectTemplatePayload),
    isSeeded: row.isSeeded,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeRaw(db: VelarisDb | Database.Database): Database.Database {
  return "$client" in db
    ? rawDb(db as VelarisDb)
    : (db as Database.Database);
}

/* ------------------------------ Reading ----------------------------- */

export function listTemplates(
  db: VelarisDb,
  opts: { kind?: TemplateKind } = {},
): TemplateDto[] {
  const rows = opts.kind
    ? db.select().from(templates).where(eq(templates.kind, opts.kind)).all()
    : db.select().from(templates).all();
  return rows
    .sort((a, b) => {
      // Seeded defaults first (stable, predictable list), then newest-first.
      if (a.isSeeded !== b.isSeeded) return a.isSeeded ? -1 : 1;
      return a.createdAt < b.createdAt ? 1 : -1;
    })
    .map(templateRowToDto);
}

export function getTemplate(db: VelarisDb, id: string): TemplateDto | null {
  const row = db.select().from(templates).where(eq(templates.id, id)).get();
  return row ? templateRowToDto(row) : null;
}

/** Find a template by its unique (kind, name). Used by the idempotent seed. */
export function findTemplateByName(
  db: VelarisDb,
  kind: TemplateKind,
  name: string,
): TemplateDto | null {
  const row = db
    .select()
    .from(templates)
    .where(and(eq(templates.kind, kind), eq(templates.name, name)))
    .limit(1)
    .get();
  return row ? templateRowToDto(row) : null;
}

/* ------------------------------ Writing ----------------------------- */

export interface CreateTemplateInput {
  id?: string;
  kind: TemplateKind;
  name: string;
  description?: string;
  payload: HouseTemplatePayload | ProjectTemplatePayload;
  /** Boot seed only; never settable through the API. */
  isSeeded?: boolean;
}

function assertNameAvailable(
  db: VelarisDb,
  kind: TemplateKind,
  name: string,
  exceptId?: string,
): void {
  const conditions = [eq(templates.kind, kind), eq(templates.name, name)];
  const row = db
    .select()
    .from(templates)
    .where(and(...conditions))
    .get();
  if (row && row.id !== exceptId) throw new TemplateNameExistsError(kind, name);
}

export function createTemplate(db: VelarisDb, input: CreateTemplateInput): TemplateDto {
  assertNameAvailable(db, input.kind, input.name);
  const id = input.id ?? randomUUID();

  db.insert(templates)
    .values({
      id,
      kind: input.kind,
      name: input.name,
      description: input.description ?? "",
      payload: JSON.stringify(input.payload ?? {}),
      isSeeded: input.isSeeded ?? false,
    })
    .run();

  return getTemplate(db, id)!;
}

export type UpdateTemplatePatch = Partial<{
  name: string;
  description: string;
  payload: HouseTemplatePayload | ProjectTemplatePayload;
}>;

export function updateTemplate(
  db: VelarisDb,
  id: string,
  patch: UpdateTemplatePatch,
): TemplateDto {
  const existing = db.select().from(templates).where(eq(templates.id, id)).get();
  if (!existing) throw new TemplateNotFoundError(id);
  if (existing.isSeeded) throw new SeededTemplateError(id);

  if (patch.name !== undefined && patch.name !== existing.name) {
    assertNameAvailable(db, existing.kind as TemplateKind, patch.name, id);
  }

  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.payload !== undefined) set.payload = JSON.stringify(patch.payload);
  if (Object.keys(set).length) {
    set.updatedAt = new Date().toISOString();
    db.update(templates).set(set).where(eq(templates.id, id)).run();
  }

  return getTemplate(db, id)!;
}

export function deleteTemplate(db: VelarisDb, id: string): void {
  const existing = db.select().from(templates).where(eq(templates.id, id)).get();
  if (!existing) throw new TemplateNotFoundError(id);
  if (existing.isSeeded) throw new SeededTemplateError(id);
  db.delete(templates).where(eq(templates.id, id)).run();
}

/* ------------------------------- Seeding ---------------------------- */

/**
 * Idempotent seed of the default house/project templates: inserts only when no
 * row with the same (kind, name) exists, so it NEVER clobbers user edits or a
 * previously seeded row. Returns the number inserted.
 *
 * Called on boot by web + engine. Accepts either the Drizzle wrapper or the raw
 * connection so the (raw) engine process can call it too.
 */
export function seedDefaultTemplates(db: VelarisDb | Database.Database): number {
  const raw = normalizeRaw(db);
  const exists = raw.prepare(
    "SELECT id FROM templates WHERE kind = ? AND name = ? LIMIT 1",
  );
  const insert = raw.prepare(
    `INSERT INTO templates (id, kind, name, description, payload, is_seeded, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  );

  let inserted = 0;
  const now = new Date().toISOString();
  for (const t of DEFAULT_TEMPLATES) {
    if (exists.get(t.kind, t.name)) continue;
    insert.run(randomUUID(), t.kind, t.name, t.description, JSON.stringify(t.payload), now, now);
    inserted += 1;
  }
  return inserted;
}
