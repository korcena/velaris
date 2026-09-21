/**
 * Web-process bootstrap: ensures the database schema is migrated and default
 * provider configs are seeded, exactly once per process. The engine performs
 * the same boot procedure independently; both are idempotent against the
 * shared SQLite file.
 */

import { migrate } from "@/lib/db/migrate";
import { getRawDb } from "@/lib/db";
import { seedDefaultProviderConfigs } from "@/server/repositories/provider-config-repo";

let _done = false;

export function bootstrapDb(): void {
  if (_done) return;
  migrate();
  seedDefaultProviderConfigs(getRawDb());
  _done = true;
}

/** Test helper to force a re-run against a fresh DB. */
export function resetBootstrapForTests(): void {
  _done = false;
}
