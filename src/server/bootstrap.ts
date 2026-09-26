/**
 * Web-process bootstrap: ensures the database schema is migrated and default
 * provider configs are seeded, exactly once per process. The engine performs
 * the same boot procedure independently; both are idempotent against the
 * shared SQLite file.
 */

import { migrate } from "@/lib/db/migrate";
import { getDb, getRawDb } from "@/lib/db";
import { seedDefaultProviderConfigs } from "@/server/repositories/provider-config-repo";
import { seedHighLordHouse, seedDefaultHouses } from "@/server/repositories/house-repo";
import { seedDefaultTemplates } from "@/server/repositories/template-repo";

let _done = false;

export function bootstrapDb(): void {
  if (_done) return;
  migrate();
  seedDefaultProviderConfigs(getRawDb());
  // Seed the singleton High Lord house (idempotent; never clobbers user edits).
  seedHighLordHouse(getRawDb());
  // Seed the ten default ACOTAR houses (idempotent, no-clobber by exact name;
  // never renames/merges/deletes an existing house).
  seedDefaultHouses(getRawDb());
  // Seed the default house/project templates (idempotent by (kind,name);
  // seeded rows are immutable so user edits are never clobbered).
  seedDefaultTemplates(getRawDb());
  _done = true;
}

/** Test helper to force a re-run against a fresh DB. */
export function resetBootstrapForTests(): void {
  _done = false;
}
