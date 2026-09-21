/**
 * better-sqlite3 singleton — shared by the web process, the engine process,
 * and tooling.
 *
 * Safety for cross-process access (web ⇄ engine):
 *  - PRAGMA journal_mode = WAL
 *  - PRAGMA busy_timeout = 5000
 *  - PRAGMA foreign_keys = ON
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import fs from "node:fs";

/**
 * Resolve the database file path. Priority:
 *  1. VELARIS_DB_PATH env (absolute -> as-is).
 *  2. Default ./db/velaris.db relative to the project root.
 *
 * Relative paths are resolved against process.cwd(), which for npm scripts is
 * the project root.
 */
export function resolveDbPath(raw?: string | null): string {
  const value = raw || process.env.VELARIS_DB_PATH || "./db/velaris.db";
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function ensureDir(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

export type VelarisRawDb = Database.Database;
export type VelarisDb = BetterSQLite3Database;

/** Access the underlying raw better-sqlite3 connection from the Drizzle wrapper. */
export function rawDb(db: VelarisDb): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client;
}

declare global {
  // eslint-disable-next-line no-var
  var __velarisDb: Database.Database | undefined;
  // eslint-disable-next-line no-var
  var __velarisDrizzle: VelarisDb | undefined;
}

let _raw: Database.Database | null = null;
let _db: VelarisDb | null = null;

/**
 * Return the singleton better-sqlite3 connection with the required pragmas
 * applied. Safe to call from any process/module.
 */
export function getDb(dbPath?: string): VelarisDb {
  const raw = getRawDb(dbPath);
  if (_db) return _db;
  _db = drizzle(raw);
  globalThis.__velarisDrizzle = _db;
  return _db;
}

/**
 * Return the raw better-sqlite3 connection (for pragma/prepare/close and the
 * engine's low-level access). Lazily initialises the connection with pragmas.
 */
export function getRawDb(dbPath?: string): VelarisRawDb {
  if (_raw) return _raw;
  // Reuse a hot-reload-safe global so Next.js dev HMR does not open many handles.
  if (globalThis.__velarisDb) {
    _raw = globalThis.__velarisDb;
    return _raw;
  }

  const resolved = resolveDbPath(dbPath);
  ensureDir(resolved);

  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  _raw = db;
  globalThis.__velarisDb = db;
  return db;
}

/** Test helper: reset the singleton (used against temp DB files). */
export function resetDbForTests(): void {
  if (_raw) {
    _raw.close();
    _raw = null;
  }
  _db = null;
  globalThis.__velarisDb = undefined;
  globalThis.__velarisDrizzle = undefined;
}

/** Close the singleton and detach the globals. */
export function closeDb(): void {
  if (_raw) {
    _raw.close();
    _raw = null;
  }
  _db = null;
  globalThis.__velarisDb = undefined;
  globalThis.__velarisDrizzle = undefined;
}
