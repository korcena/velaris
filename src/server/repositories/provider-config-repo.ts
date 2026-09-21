/**
 * Provider config repository — CRUD with one-default-per-type enforcement
 * and idempotent seeding of default providers.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { eq, and } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { DEFAULT_PROVIDER_BASE_URLS } from "@/shared/constants";
import { parseJson } from "@/shared/schemas/common";
import type { ProviderConfigDto, ProviderConfigType } from "@/shared/types";

export class ProviderConfigNotFoundError extends Error {
  constructor(id: string) {
    super(`Provider config not found: ${id}`);
    this.name = "ProviderConfigNotFoundError";
  }
}

/* ------------------------------ Mapping ----------------------------- */

export function providerRowToDto(row: (typeof providerConfigs.$inferSelect)): ProviderConfigDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ProviderConfigType,
    baseUrl: row.baseUrl,
    isDefault: row.isDefault,
    extra: parseJson<Record<string, unknown>>(row.extra, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------ Reading ----------------------------- */

export function listProviderConfigs(db: VelarisDb): ProviderConfigDto[] {
  return db
    .select()
    .from(providerConfigs)
    .orderBy(providerConfigs.createdAt)
    .all()
    .map(providerRowToDto);
}

export function getProviderConfig(db: VelarisDb, id: string): ProviderConfigDto | null {
  const row = db.select().from(providerConfigs).where(eq(providerConfigs.id, id)).get();
  return row ? providerRowToDto(row) : null;
}

/**
 * Idempotent seed of the two default provider configs (only inserts if a
 * config of that type does not already exist). Called on boot by web + engine.
 *
 * Accepts either the Drizzle wrapper or the raw better-sqlite3 connection so
 * it can run from both the web process and the (raw) engine process.
 */
export function seedDefaultProviderConfigs(
  db: VelarisDb | Database.Database,
): number {
  // Normalise to the underlying raw connection regardless of which type we got.
  // The Drizzle wrapper does NOT expose `prepare` (it's the raw connection's
  // API), so detect the wrapper by its $client property instead.
  const raw: Database.Database =
    "$client" in db
      ? ((db as VelarisDb) as unknown as { $client: Database.Database }).$client
      : (db as Database.Database);

  let inserted = 0;
  const defaults: { name: string; type: ProviderConfigType }[] = [
    { name: "OpenCode (local)", type: "opencode" },
    { name: "Ollama (local)", type: "ollama" },
  ];

  const exists = raw.prepare("SELECT id FROM provider_configs WHERE type = ? LIMIT 1");
  const insert = raw.prepare(
    `INSERT INTO provider_configs (id, name, type, base_url, is_default, extra)
     VALUES (?, ?, ?, ?, 1, '{}')`,
  );

  for (const d of defaults) {
    const row = exists.get(d.type);
    if (row) continue;
    insert.run(randomUUID(), d.name, d.type, DEFAULT_PROVIDER_BASE_URLS[d.type]);
    inserted += 1;
  }
  return inserted;
}

/* ------------------------- one-default-per-type --------------------- */

/** Clear the default flag for a type (used when another becomes default). */
export function clearDefaultForType(db: VelarisDb, type: ProviderConfigType, exceptId?: string): void {
  const rows = db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.type, type), eq(providerConfigs.isDefault, true)))
    .all();

  for (const row of rows) {
    if (row.id === exceptId) continue;
    db.update(providerConfigs)
      .set({ isDefault: false, updatedAt: new Date().toISOString() })
      .where(eq(providerConfigs.id, row.id))
      .run();
  }
}

/* ------------------------------ Writing ----------------------------- */

export interface CreateProviderConfigInput {
  id?: string;
  name: string;
  type: ProviderConfigType;
  baseUrl: string;
  isDefault?: boolean;
  extra?: Record<string, unknown>;
}

export function createProviderConfig(db: VelarisDb, input: CreateProviderConfigInput): ProviderConfigDto {
  const id = input.id ?? randomUUID();
  const isDefault = input.isDefault ?? false;

  db.transaction((tx) => {
    if (isDefault) clearDefaultForType(tx as unknown as VelarisDb, input.type);
    tx.insert(providerConfigs)
      .values({
        id,
        name: input.name,
        type: input.type,
        baseUrl: input.baseUrl,
        isDefault,
        extra: JSON.stringify(input.extra ?? {}),
      })
      .run();
  });

  return getProviderConfig(db, id)!;
}

export type UpdateProviderConfigPatch = Partial<{
  name: string;
  type: ProviderConfigType;
  baseUrl: string;
  isDefault: boolean;
  extra: Record<string, unknown>;
}>;

export function updateProviderConfig(
  db: VelarisDb,
  id: string,
  patch: UpdateProviderConfigPatch,
): ProviderConfigDto {
  const existing = db.select().from(providerConfigs).where(eq(providerConfigs.id, id)).get();
  if (!existing) throw new ProviderConfigNotFoundError(id);

  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
  if (patch.extra !== undefined) set.extra = JSON.stringify(patch.extra);
  const changedToDefault =
    patch.isDefault === true && existing.isDefault === false;

  db.transaction((tx) => {
    if (changedToDefault) {
      clearDefaultForType(tx as unknown as VelarisDb, existing.type as ProviderConfigType, id);
    }
    if (patch.isDefault !== undefined) set.isDefault = patch.isDefault;
    if (Object.keys(set).length) {
      set.updatedAt = new Date().toISOString();
      tx.update(providerConfigs).set(set).where(eq(providerConfigs.id, id)).run();
    }
  });

  // If the last default config's flag is cleared the type ends up with none;
  // the service layer is responsible for preventing "no default" states.
  return getProviderConfig(db, id)!;
}

export function deleteProviderConfig(db: VelarisDb, id: string): void {
  const existing = db.select().from(providerConfigs).where(eq(providerConfigs.id, id)).get();
  if (!existing) throw new ProviderConfigNotFoundError(id);
  db.delete(providerConfigs).where(eq(providerConfigs.id, id)).run();
}
