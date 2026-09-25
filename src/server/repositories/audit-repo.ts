/**
 * Audit log repository — append-only user-action audit trail.
 *
 * Phase 6 Stage A / decision Q9: the web process records only WEB USER-ACTION
 * rows (house/agent/project/provider-config/template CRUD + approval responses).
 * Engine execution lifecycle is deliberately NOT duplicated here — it already
 * lives in `execution_events`. A small optional engine-owned set (e.g. plan
 * abort) is an additive follow-up and is out of scope for this stage.
 *
 * `recordAudit` is fire-and-forget: it must NEVER throw into the request path,
 * so a failed audit write is caught + logged and cannot break a user action.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { parseJson } from "@/shared/schemas/common";
import type { AuditActor, AuditEntityType, AuditLogDto } from "@/shared/types";

/* ------------------------------ Mapping ----------------------------- */

function auditRowToDto(row: typeof auditLog.$inferSelect): AuditLogDto {
  return {
    id: row.id,
    actor: row.actor as AuditActor,
    actorAgentId: row.actorAgentId ?? null,
    action: row.action,
    entityType: row.entityType as AuditEntityType,
    entityId: row.entityId ?? null,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.createdAt,
  };
}

/* ------------------------------ Writing ----------------------------- */

export interface RecordAuditInput {
  /** Defaults to 'user' (the web process's only writer in this stage). */
  actor?: AuditActor;
  /** Optional agent attribution (e.g. agent CRUD). */
  actorAgentId?: string | null;
  action: string;
  entityType: AuditEntityType | string; // extensible: the column has no CHECK
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  /** Test/seed override. */
  id?: string;
}

/**
 * Append an audit row. Fire-and-forget: returns the new id on success or `null`
 * when the write failed (error logged, never rethrown) so auditing can never
 * break a user action.
 */
export function recordAudit(db: VelarisDb, input: RecordAuditInput): string | null {
  try {
    const id = input.id ?? randomUUID();
    db.insert(auditLog)
      .values({
        id,
        actor: input.actor ?? "user",
        actorAgentId: input.actorAgentId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
      })
      .run();
    return id;
  } catch (err) {
    console.error("[velaris] audit write failed:", err);
    return null;
  }
}

/* ------------------------------ Reading ----------------------------- */

export interface ListAuditLogOptions {
  limit?: number;
  offset?: number;
  actor?: AuditActor;
  entityType?: string;
  entityId?: string;
  action?: string;
  /** ISO lower bound (created_at > from). */
  from?: string;
}

/** List audit entries newest-first with optional filters. */
export function listAuditLog(db: VelarisDb, opts: ListAuditLogOptions = {}): AuditLogDto[] {
  const conditions: SQL[] = [];
  if (opts.actor !== undefined) conditions.push(eq(auditLog.actor, opts.actor));
  if (opts.entityType !== undefined) conditions.push(eq(auditLog.entityType, opts.entityType));
  if (opts.entityId !== undefined) conditions.push(eq(auditLog.entityId, opts.entityId));
  if (opts.action !== undefined) conditions.push(eq(auditLog.action, opts.action));
  if (opts.from !== undefined) conditions.push(sql`${auditLog.createdAt} > ${opts.from}`);

  const limit = Math.max(1, opts.limit ?? 25);
  const offset = Math.max(0, opts.offset ?? 0);

  const query = db.select().from(auditLog);
  const filtered = conditions.length ? query.where(and(...conditions)) : query;
  return filtered
    // rowid tiebreak keeps pagination stable when two rows share a millisecond.
    .orderBy(sql`${auditLog.createdAt} DESC, rowid DESC`)
    .limit(limit)
    .offset(offset)
    .all()
    .map(auditRowToDto);
}
