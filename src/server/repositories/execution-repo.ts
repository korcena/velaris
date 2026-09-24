/**
 * Execution repository — repositories for execution_sessions, execution_events,
 * agent_messages, approval_requests, notifications, artifacts and usage_records.
 *
 * WRITE DISCIPLINE (ARCHITECTURE §3 / AGENT_ORCHESTRATION):
 *  - The ENGINE is the single writer of execution_sessions / execution_events /
 *    agent_messages / artifacts / usage_records and the approval_requests row
 *    *creation + final relay state* (approved/replied/rejected → engine acts).
 *  - The WEB process writes only: approval_requests response transitions
 *    (via POST /api/approvals/{id}/respond) and notifications.read.
 *  - Web reads these tables to serve /api/stream + the P2 API.
 *
 * The Drizzle query builder is shared; hot stream tables use INTEGER
 * autoincrement PKs so `id > lastSeenId` polling is lossless.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { eq, and, sql, desc, gt, sum, count } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import {
  executionSessions,
  executionEvents,
  agentMessages,
  approvalRequests,
  notifications,
  artifacts,
  usageRecords,
  subtasks,
  type ExecutionSessionRow,
  type ExecutionEventRow,
  type ApprovalRequestRow,
  type NotificationRow,
} from "@/lib/db/schema";
import { parseJson } from "@/shared/schemas/common";
import type {
  ExecutionSessionDto,
  ExecutionEventDto,
  AgentMessageDto,
  ApprovalRequestDto,
  ApprovalKind,
  ApprovalStatus,
  NotificationDto,
  NotificationType,
  ArtifactDto,
  SessionStatus,
  ExecutionEventType,
  ArtifactKind,
  CostSummary,
  HouseUsageSummary,
} from "@/shared/types";

/* ================================================================== */
/* execution_sessions                                                  */
/* ================================================================== */

export interface CreateSessionInput {
  id?: string;
  taskId: string;
  houseId: string;
  agentId?: string | null;
  provider: string;
  modelId: string;
  directory?: string | null;
}

export function createExecutionSession(
  db: VelarisDb,
  input: CreateSessionInput,
): ExecutionSessionDto {
  const id = input.id ?? randomUUID();
  db.insert(executionSessions)
    .values({
      id,
      taskId: input.taskId,
      houseId: input.houseId,
      agentId: input.agentId ?? null,
      provider: input.provider,
      modelId: input.modelId,
      directory: input.directory ?? null,
      status: "pending",
      startedAt: new Date().toISOString(),
    })
    .run();
  return getExecutionSession(db, id)!;
}

export function getExecutionSession(
  db: VelarisDb,
  id: string,
): ExecutionSessionDto | null {
  const row = db
    .select()
    .from(executionSessions)
    .where(eq(executionSessions.id, id))
    .get();
  return row ? sessionRowToDto(row) : null;
}

export function getExecutionSessionByProviderId(
  db: VelarisDb,
  providerSessionId: string,
): ExecutionSessionDto | null {
  const row = db
    .select()
    .from(executionSessions)
    .where(eq(executionSessions.providerSessionId, providerSessionId))
    .get();
  return row ? sessionRowToDto(row) : null;
}

export function listSessionsForTask(db: VelarisDb, taskId: string): ExecutionSessionDto[] {
  return db
    .select()
    .from(executionSessions)
    .where(eq(executionSessions.taskId, taskId))
    .orderBy(executionSessions.createdAt)
    .all()
    .map(sessionRowToDto);
}

export function getActiveSessionForHouse(db: VelarisDb, houseId: string): ExecutionSessionDto | null {
  const row = db
    .select()
    .from(executionSessions)
    .where(
      eq(executionSessions.houseId, houseId),
    )
    .orderBy(desc(executionSessions.createdAt))
    .all()
    .find((s) =>
      ["pending", "running", "awaiting_approval", "awaiting_input"].includes(
        s.status as SessionStatus,
      ),
    );
  return row ? sessionRowToDto(row) : null;
}

function sessionRowToDto(row: ExecutionSessionRow): ExecutionSessionDto {
  return {
    id: row.id,
    taskId: row.taskId,
    houseId: row.houseId,
    agentId: row.agentId ?? null,
    providerSessionId: row.providerSessionId ?? null,
    status: row.status as SessionStatus,
    provider: row.provider,
    modelId: row.modelId,
    directory: row.directory ?? null,
    lastError: row.lastError ?? null,
    costTotal: row.costTotal,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Engine-only: bind the provider session id to a Velaris session row. */
export function setSessionProviderId(
  db: VelarisDb,
  sessionId: string,
  providerSessionId: string,
): void {
  db.update(executionSessions)
    .set({ providerSessionId, updatedAt: new Date().toISOString() })
    .where(eq(executionSessions.id, sessionId))
    .run();
}

/** Engine-only: transition a session's status. */
export function setSessionStatus(
  db: VelarisDb,
  sessionId: string,
  status: SessionStatus,
  extra?: Partial<{
    lastError: string;
    finishedAt: string;
    costTotal: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
  }>,
): void {
  const patch: Record<string, unknown> = { status, updatedAt: new Date().toISOString() };
  if (extra?.lastError !== undefined) patch.lastError = extra.lastError;
  if (extra?.finishedAt !== undefined) patch.finishedAt = extra.finishedAt;
  if (extra?.costTotal !== undefined) patch.costTotal = extra.costTotal;
  if (extra?.inputTokens !== undefined) patch.inputTokens = extra.inputTokens;
  if (extra?.outputTokens !== undefined) patch.outputTokens = extra.outputTokens;
  if (extra?.reasoningTokens !== undefined) patch.reasoningTokens = extra.reasoningTokens;
  if (extra?.cacheReadTokens !== undefined) patch.cacheReadTokens = extra.cacheReadTokens;
  db.update(executionSessions)
    .set(patch)
    .where(eq(executionSessions.id, sessionId))
    .run();
}

/** Alias used by the engine's reconciliation paths. */
export const setExecutionSessionStatus = setSessionStatus;

/* ================================================================== */
/* execution_events (engine writes only)                              */
/* ================================================================== */

export interface CreateEventInput {
  sessionId?: string | null;
  taskId?: string | null;
  houseId?: string | null;
  rawType: string;
  type: ExecutionEventType;
  payload?: Record<string, unknown>;
}

export function createExecutionEvent(
  db: VelarisDb,
  input: CreateEventInput,
): number {
  const res = db
    .insert(executionEvents)
    .values({
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      houseId: input.houseId ?? null,
      rawType: input.rawType,
      type: input.type,
      payload: JSON.stringify(input.payload ?? {}),
    })
    .run();
  return Number(res.lastInsertRowid);
}

export function listEventsAfter(
  db: VelarisDb,
  afterId: number,
  limit = 500,
): ExecutionEventDto[] {
  const rows = db
    .select()
    .from(executionEvents)
    .where(gt(executionEvents.id, afterId))
    .orderBy(executionEvents.id)
    .limit(limit)
    .all();
  return rows.map(eventRowToDto);
}

export function listEventsForTask(
  db: VelarisDb,
  taskId: string,
  afterId?: number,
): ExecutionEventDto[] {
  const rows = db
    .select()
    .from(executionEvents)
    .where(
      afterId !== undefined
        ? and(eq(executionEvents.taskId, taskId), gt(executionEvents.id, afterId))
        : eq(executionEvents.taskId, taskId),
    )
    .orderBy(executionEvents.id)
    .limit(1000)
    .all();
  return rows.map(eventRowToDto);
}

export function getLatestEventId(db: VelarisDb): number {
  const row = db
    .select({ id: executionEvents.id })
    .from(executionEvents)
    .orderBy(desc(executionEvents.id))
    .limit(1)
    .get();
  return row?.id ?? 0;
}

function eventRowToDto(row: ExecutionEventRow): ExecutionEventDto {
  return {
    id: row.id,
    sessionId: row.sessionId ?? null,
    taskId: row.taskId ?? null,
    houseId: row.houseId ?? null,
    rawType: row.rawType,
    type: row.type as ExecutionEventType,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    createdAt: row.createdAt,
  };
}

/* ================================================================== */
/* agent_messages                                                       */
/* ================================================================== */

export interface CreateAgentMessageInput {
  id?: string;
  sessionId: string;
  role: "user" | "agent";
  content: string;
  /** Provider message id — used as the dedupe key for streaming deltas. */
  providerMessageId?: string | null;
  /** Engine-only outbound marker: set once a user message is relayed. */
  relayedAt?: string | null;
}

/**
 * Upsert an agent message. Streaming `message.updated` / `part.updated` deltas
 * for the same provider message id are merged into the existing row (content is
 * updated in place, never duplicated). When no providerMessageId is supplied it
 * behaves as an insert (bug 7 — dedupe duplicate message rows from streaming).
 */
export function upsertAgentMessage(
  db: VelarisDb,
  input: CreateAgentMessageInput,
): void {
  const id = input.id ?? randomUUID();
  if (input.providerMessageId) {
    const existing = db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.providerMessageId, input.providerMessageId))
      .get();
    if (existing) {
      // Update the existing row's content so the latest delta text wins.
      db.update(agentMessages)
        .set({ content: input.content })
        .where(
          and(
            eq(agentMessages.providerMessageId, input.providerMessageId),
            eq(agentMessages.sessionId, input.sessionId),
          ),
        )
        .run();
      return;
    }
  }
  db.insert(agentMessages)
    .values({
      id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      providerMessageId: input.providerMessageId ?? null,
      relayedAt: input.relayedAt ?? null,
    })
    .run();
}

/** Backward-compatible insert (used by web POST messages and non-delta writes). */
export function createAgentMessage(
  db: VelarisDb,
  input: CreateAgentMessageInput,
): void {
  upsertAgentMessage(db, input);
}

/**
 * Engine-only: mark a user message as relayed to the provider so the runner's
 * poll loop never re-sends it (bug 2 — chat relay duplicates). State survives
 * engine restart because it is a DB column, not in-memory.
 */
export function markAgentMessageRelayed(
  db: VelarisDb,
  messageId: string,
): void {
  db.update(agentMessages)
    .set({ relayedAt: new Date().toISOString() })
    .where(eq(agentMessages.id, messageId))
    .run();
}

export function listAgentMessagesForSession(
  db: VelarisDb,
  sessionId: string,
): AgentMessageDto[] {
  return db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, sessionId))
    .orderBy(agentMessages.createdAt)
    .all()
    .map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      role: r.role as "user" | "agent",
      content: r.content,
      createdAt: r.createdAt,
    }));
}

/**
 * Engine-only: pick up user outbound messages for a session that do not yet
 * have a corresponding agent reply AND have not already been relayed to the
 * provider (relayed_at set — bug 2: never re-send a prompt every poll tick).
 * Returns the newest un-relayed, un-answered user message.
 */
export function findPendingUserMessage(
  raw: Database.Database,
  sessionId: string,
  lastAgentMessageAt: string | null,
): { id: string; content: string } | null {
  const q = `
    SELECT id, content FROM agent_messages
    WHERE session_id = ? AND role = 'user' AND relayed_at IS NULL
      AND (? IS NULL OR created_at > ?)
    ORDER BY created_at ASC LIMIT 1
  `;
  const row = raw.prepare(q).get(sessionId, lastAgentMessageAt, lastAgentMessageAt) as
    | { id: string; content: string }
    | undefined;
  return row ?? null;
}

/* ================================================================== */
/* approval_requests                                                    */
/* ================================================================== */

export interface CreateApprovalInput {
  id?: string;
  sessionId: string;
  taskId?: string | null;
  houseId?: string | null;
  providerRequestId: string;
  kind: ApprovalKind;
  title: string;
  message: string;
  options?: Array<{ id: string; label: string }>;
}

export function createApprovalRequest(
  db: VelarisDb,
  input: CreateApprovalInput,
): ApprovalRequestDto | null {
  const id = input.id ?? randomUUID();
  try {
    db.insert(approvalRequests)
      .values({
        id,
        sessionId: input.sessionId,
        taskId: input.taskId ?? null,
        houseId: input.houseId ?? null,
        providerRequestId: input.providerRequestId,
        kind: input.kind,
        status: "pending",
        title: input.title,
        message: input.message,
        options: JSON.stringify(input.options ?? []),
      })
      .run();
  } catch (err) {
    const e = err as { code?: string };
    if (e.code?.startsWith("SQLITE_CONSTRAINT")) {
      // Duplicate provider_request_id (re-sync) — return the existing row.
      return getApprovalByProviderId(db, input.providerRequestId);
    }
    throw err;
  }
  return getApprovalById(db, id);
}

export function getApprovalById(db: VelarisDb, id: string): ApprovalRequestDto | null {
  const row = db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get();
  return row ? approvalRowToDto(row) : null;
}

export function getApprovalByProviderId(
  db: VelarisDb,
  providerRequestId: string,
): ApprovalRequestDto | null {
  const row = db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.providerRequestId, providerRequestId))
    .get();
  return row ? approvalRowToDto(row) : null;
}

export function listApprovalRequests(
  db: VelarisDb,
  opts: { status?: ApprovalStatus; houseId?: string } = {},
): ApprovalRequestDto[] {
  const conds = [
    opts.status ? eq(approvalRequests.status, opts.status) : undefined,
    opts.houseId ? eq(approvalRequests.houseId, opts.houseId) : undefined,
  ].filter((c): c is ReturnType<typeof eq> => c !== undefined);
  const rows = conds.length
    ? db.select().from(approvalRequests).where(and(...conds))
    : db.select().from(approvalRequests);
  return rows.orderBy(desc(approvalRequests.createdAt)).all().map(approvalRowToDto);
}

/**
 * WEB writes approval responses. Sets status (approved / rejected / replied)
 * + response text + responded_at. The engine later relays to the provider and
 * flips status → 'resolved'-equivalent only via cancel on session end.
 */
export function setApprovalResponse(
  db: VelarisDb,
  id: string,
  status: ApprovalStatus,
  response: string | null,
): ApprovalRequestDto | null {
  const existing = db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get();
  if (!existing) return null;
  if (existing.status !== "pending") {
    // Already responded — idempotency guard: allow re-apply but don't resurrect.
    return approvalRowToDto(existing);
  }
  db.update(approvalRequests)
    .set({ status, response, respondedAt: new Date().toISOString() })
    .where(eq(approvalRequests.id, id))
    .run();
  return getApprovalById(db, id);
}

/** Engine-only: auto-close approvals when a session ends (status → cancelled). */
export function cancelPendingApprovalsForSession(db: VelarisDb, sessionId: string): void {
  db.update(approvalRequests)
    .set({ status: "cancelled", respondedAt: new Date().toISOString() })
    .where(and(eq(approvalRequests.sessionId, sessionId), eq(approvalRequests.status, "pending")))
    .run();
}

/** Engine-only: approvals pending in a session still awaiting relay (a user has
 * responded but we have not yet pushed the action to the provider). Bug 5: a
 * responded approval is kept distinct from "relayed" via `relayed_at` — the
 * user's chosen status (approved/rejected/replied) is never conflated with a
 * terminal "cancelled" marker. */
export function listRespondedApprovalsForSession(
  db: VelarisDb,
  sessionId: string,
): ApprovalRequestDto[] {
  const rows = db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.sessionId, sessionId),
        sql`status in ('approved','rejected','replied') AND relayed_at IS NULL`,
      ),
    )
    .orderBy(approvalRequests.createdAt)
    .all();
  return rows.map(approvalRowToDto);
}

/**
 * Engine-only: mark an approval as relayed to the provider (bug 5). Only the
 * `relayed_at` marker changes — the user's chosen status stays as-is so history
 * correctly reports approved/rejected/replied rather than misreporting
 * "cancelled".
 */
export function markApprovalRelayed(
  db: VelarisDb,
  providerRequestId: string,
): void {
  db.update(approvalRequests)
    .set({ relayedAt: new Date().toISOString() })
    .where(eq(approvalRequests.providerRequestId, providerRequestId))
    .run();
}

function approvalRowToDto(row: ApprovalRequestRow): ApprovalRequestDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    taskId: row.taskId ?? null,
    houseId: row.houseId ?? null,
    providerRequestId: row.providerRequestId,
    kind: row.kind as ApprovalKind,
    status: row.status as ApprovalStatus,
    title: row.title,
    message: row.message,
    options: parseJson<Array<{ id: string; label: string }>>(row.options, []),
    response: row.response ?? null,
    createdAt: row.createdAt,
    respondedAt: row.respondedAt ?? null,
    relayedAt: row.relayedAt ?? null,
  };
}

/* ================================================================== */
/* notifications                                                        */
/* ================================================================== */

export interface CreateNotificationInput {
  id?: string;
  type: NotificationType;
  title: string;
  body?: string;
  houseId?: string | null;
  taskId?: string | null;
  approvalRequestId?: string | null;
}

export function createNotification(
  db: VelarisDb,
  input: CreateNotificationInput,
): void {
  const id = input.id ?? randomUUID();
  db.insert(notifications)
    .values({
      id,
      type: input.type,
      title: input.title,
      body: input.body ?? "",
      houseId: input.houseId ?? null,
      taskId: input.taskId ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      read: false,
    })
    .run();
}

export function listNotifications(
  db: VelarisDb,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): NotificationDto[] {
  const rows = db
    .select()
    .from(notifications)
    .where(opts.unreadOnly ? eq(notifications.read, false) : undefined)
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 100)
    .all();
  return rows.map(notificationRowToDto);
}

export function getNotification(db: VelarisDb, id: string): NotificationDto | null {
  const row = db.select().from(notifications).where(eq(notifications.id, id)).get();
  return row ? notificationRowToDto(row) : null;
}

/** WEB writes read state. */
export function setNotificationRead(db: VelarisDb, id: string, read: boolean): void {
  db.update(notifications).set({ read }).where(eq(notifications.id, id)).run();
}

/**
 * WEB writes read state for all notifications linked to an approval request
 * (bug 10 — the bird notification must not stay unread after the user responds).
 * Notifications are created with an explicit `approvalRequestId` link, so we
 * mark by that foreign key.
 */
export function markNotificationsReadForApproval(
  db: VelarisDb,
  approvalRequestId: string,
): number {
  const res = db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.approvalRequestId, approvalRequestId), eq(notifications.read, false)))
    .run();
  return res.changes;
}

/** WEB writes read state for all notifications (optionally scoped to a type). */
export function markAllNotificationsRead(
  db: VelarisDb,
  opts: { type?: NotificationType } = {},
): number {
  const cond = opts.type ? eq(notifications.type, opts.type) : undefined;
  const res = cond
    ? db.update(notifications).set({ read: true }).where(cond).run()
    : db.update(notifications).set({ read: true }).run();
  return res.changes;
}

export function countUnreadNotifications(db: VelarisDb): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(eq(notifications.read, false))
    .get();
  return row?.count ?? 0;
}

/**
 * WEB-only: notifications with id > afterId (or all recent when afterId is
 * null), used by /api/stream's 500ms change-feed tick. Notifications use uuid
 * ids, so the cursor is the createdAt timestamp plus an optional id to break
 * ties within the same millisecond.
 */
export function listNotificationsNewerThan(
  db: VelarisDb,
  afterCreatedAt: string | null,
  afterId: string | null,
): NotificationDto[] {
  const rows = db
    .select()
    .from(notifications)
    .where(
      afterCreatedAt
        ? sql`created_at > ${afterCreatedAt} OR (created_at = ${afterCreatedAt} AND id > ${afterId ?? ""})`
        : undefined,
    )
    .orderBy(desc(notifications.createdAt))
    .all();
  return rows.map(notificationRowToDto);
}

function notificationRowToDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    houseId: row.houseId ?? null,
    taskId: row.taskId ?? null,
    approvalRequestId: row.approvalRequestId ?? null,
    read: row.read,
    createdAt: row.createdAt,
  };
}

/* ================================================================== */
/* artifacts                                                            */
/* ================================================================== */

export function createArtifact(
  db: VelarisDb,
  input: {
    id?: string;
    sessionId: string;
    taskId?: string | null;
    kind: ArtifactKind;
    content: string;
  },
): void {
  const id = input.id ?? randomUUID();
  db.insert(artifacts)
    .values({
      id,
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      kind: input.kind,
      content: input.content,
    })
    .run();
}

export function listArtifactsForSession(db: VelarisDb, sessionId: string): ArtifactDto[] {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.sessionId, sessionId))
    .orderBy(artifacts.createdAt)
    .all()
    .map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      taskId: r.taskId ?? null,
      kind: r.kind as ArtifactKind,
      content: r.content,
      createdAt: r.createdAt,
    }));
}

/** All artifacts a task produced across its sessions, in creation order. */
export function listArtifactsForTask(db: VelarisDb, taskId: string): ArtifactDto[] {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(artifacts.createdAt)
    .all()
    .map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      taskId: r.taskId ?? null,
      kind: r.kind as ArtifactKind,
      content: r.content,
      createdAt: r.createdAt,
    }));
}

/* ================================================================== */
/* usage_records                                                       */
/* ================================================================== */

export function createUsageRecord(
  db: VelarisDb,
  input: {
    id?: string;
    sessionId: string;
    taskId?: string | null;
    houseId?: string | null;
    modelId: string;
    provider: string;
    cost: {
      total?: number;
      cost?: number;
      inputTokens?: number;
      input?: number;
      outputTokens?: number;
      output?: number;
      reasoningTokens?: number;
      reasoning?: number;
      cacheReadTokens?: number;
      cacheRead?: number;
    };
    estimated?: boolean;
  },
): void {
  const id = input.id ?? randomUUID();
  const c = input.cost;
  const inputTokens = c.inputTokens ?? c.input ?? 0;
  const outputTokens = c.outputTokens ?? c.output ?? 0;
  const reasoningTokens = c.reasoningTokens ?? c.reasoning ?? 0;
  const cacheReadTokens = c.cacheReadTokens ?? c.cacheRead ?? 0;
  const cost = c.total ?? c.cost ?? 0;
  db.insert(usageRecords)
    .values({
      id,
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      houseId: input.houseId ?? null,
      modelId: input.modelId,
      provider: input.provider,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cost,
      estimated: input.estimated ?? false,
    })
    .run();
}

/** Engine helper: compute a CostSummary from a session DTO's counters. */
export function costSummaryOf(session: ExecutionSessionDto): CostSummary {
  return {
    total: session.costTotal,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    reasoningTokens: session.reasoningTokens,
    cacheReadTokens: session.cacheReadTokens,
  };
}

/**
 * Aggregated usage summary for a house (SUM + row count over usage_records).
 * Zeroed (never null) when the house has no usage history. `total` is a live
 * SUM of the cost column so the Overview panel's "usage cost" stays current
 * even after a house's sessions have been consolidated.
 */
export function getUsageSummaryForHouse(
  db: VelarisDb,
  houseId: string,
): HouseUsageSummary {
  const row = db
    .select({
      cost: sum(usageRecords.cost),
      inputTokens: sum(usageRecords.inputTokens),
      outputTokens: sum(usageRecords.outputTokens),
      reasoningTokens: sum(usageRecords.reasoningTokens),
      cacheReadTokens: sum(usageRecords.cacheReadTokens),
      sessions: count(),
    })
    .from(usageRecords)
    .where(eq(usageRecords.houseId, houseId))
    .get();

  const num = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };

  return {
    total: num(row?.cost),
    inputTokens: num(row?.inputTokens),
    outputTokens: num(row?.outputTokens),
    reasoningTokens: num(row?.reasoningTokens),
    cacheReadTokens: num(row?.cacheReadTokens),
    sessions: num(row?.sessions),
  };
}

/**
 * Aggregated usage rollup for a High Lord parent task: SUM over usage_records
 * WHERE task_id IN (the parent task + all its child task ids). Used for the
 * parent cost rollup in the PlanDto and per-tick token-budget enforcement.
 *
 * Children are resolved via the subtasks table in a single query (subselect);
 * every usage row for the parent's planning session is included by the parent's
 * taskId, plus each child task's rows (retries add rows — intended; budget
 * counts real spend per the plan's usage-rollup risk note).
 */
export function getUsageSummaryForTask(
  db: VelarisDb,
  parentTaskId: string,
): CostSummary {
  const row = db
    .select({
      cost: sum(usageRecords.cost),
      inputTokens: sum(usageRecords.inputTokens),
      outputTokens: sum(usageRecords.outputTokens),
      reasoningTokens: sum(usageRecords.reasoningTokens),
      cacheReadTokens: sum(usageRecords.cacheReadTokens),
    })
    .from(usageRecords)
    .where(
      sql`${usageRecords.taskId} IN (
        SELECT ${parentTaskId}
        UNION
        SELECT task_id FROM subtasks WHERE parent_task_id = ${parentTaskId}
      )`,
    )
    .get();

  const num = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };

  return {
    total: num(row?.cost),
    inputTokens: num(row?.inputTokens),
    outputTokens: num(row?.outputTokens),
    reasoningTokens: num(row?.reasoningTokens),
    cacheReadTokens: num(row?.cacheReadTokens),
  };
}
