/**
 * Derived TypeScript types shared across web, engine and schema layers.
 * No executable logic lives here — pure types.
 */

import type { EXECUTION_PROVIDERS, APPROVAL_POLICIES } from "./constants";

/* ----------------------------- Primitives ---------------------------- */

export type Id = string;

export type IsoTimestamp = string;

/* ------------------------------ Houses ------------------------------ */

export type HouseStatus = "active" | "disabled" | "archived";

/** houses.kind values (echoed by ck_houses_kind). */
export type HouseKind = "agent" | "high_lord";

export type ExecutionProvider = (typeof EXECUTION_PROVIDERS)[number];

export type PermissionMode = "allow" | "ask" | "deny";

/** Per-action permission classes, per ARCHITECTURE §8. */
export interface Permissions {
  fileSystem: PermissionMode;
  shell: PermissionMode;
  network: PermissionMode;
  git: PermissionMode;
}

export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/** Stored agent_configurations.permissions JSON shape. */
export interface HouseConfiguration {
  systemPrompt: string;
  executionProvider: ExecutionProvider;
  aiProvider: string;
  modelId: string;
  workspaceAllowlist: string[];
  tools: string[];
  permissions: Permissions;
  approvalPolicy: ApprovalPolicy;
  concurrency: number;
}

export interface HouseAgent {
  name: string;
  role: string;
}

/**
 * A concrete agent row under a house (Phase 6 Stage B multi-agent). Distinct
 * from `HouseAgent` (the create/edit input shape): this carries the row id and
 * the agent's single configuration. `HouseDto.agents` lists all of them.
 */
export interface HouseAgentDto {
  id: Id;
  name: string;
  role: string;
  configuration: HouseConfiguration;
}

/** The full House DTO returned by the API (embeds agent + configuration). */
export interface HouseDto {
  id: Id;
  name: string;
  description: string | null;
  kind: HouseKind;
  status: HouseStatus;
  /**
   * Backward-compatible singular agent = the house DEFAULT agent (the OLDEST
   * agent). Existing consumers keep working unchanged; `agents` is the additive
   * multi-agent list. For a single-agent house the two are the same agent.
   */
  agent: HouseAgent;
  configuration: HouseConfiguration;
  /**
   * Phase 6 Stage B: every agent under this house, oldest-first. Always at
   * least one entry for a created/seeded house (the default agent), so
   * `agents[0]` mirrors `agent`/`configuration`.
   */
  agents: HouseAgentDto[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/* ------------------------------ Projects ---------------------------- */

export interface ProjectGitInfo {
  branch: string | null;
  remote: string | null;
  dirty: boolean;
}

export interface ProjectDto {
  id: Id;
  name: string;
  description: string | null;
  directory: string;
  gitInfo: ProjectGitInfo;
  defaultAgentId: Id | null;
  defaultModel: string | null;
  instructions: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/* --------------------------- Provider configs ------------------------ */

export type ProviderConfigType = "opencode" | "ollama";

export interface ProviderConfigDto {
  id: Id;
  name: string;
  type: ProviderConfigType;
  baseUrl: string;
  isDefault: boolean;
  extra: Record<string, unknown>;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/* ------------------------------- Tasks ------------------------------ */

export type TaskPriority = "low" | "medium" | "high" | "urgent";

/**
 * Task statuses. Phase 2 execution semantics use the full set; the tasks
 * table CHECK constraint mirrors this (src/lib/db/schema.ts / constants.ts).
 */
export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "paused";

export interface ExecutionPreferences {
  model?: string | null;
  timeoutMinutes?: number | null;
  autoApproveRisky?: boolean;
  [key: string]: unknown;
}

export interface TaskAttachment {
  name: string;
  path: string;
}

export interface TaskDto {
  id: Id;
  title: string;
  description: string;
  type: string; // extensible string, not a closed enum
  priority: TaskPriority;
  status: TaskStatus;
  houseId: Id | null;
  projectId: Id | null;
  /**
   * Phase 6 Stage B: optional target agent. Null ⇒ route to the house default
   * agent (pre-multi-agent behavior). ON DELETE SET NULL in the schema.
   */
  agentId: Id | null;
  workingDirectory: string | null;
  executionPreferences: ExecutionPreferences;
  attachments: TaskAttachment[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/* ------------------------------ Health ------------------------------ */

export interface HealthDto {
  status: "ok";
  db: "ok";
  migrations: "applied";
  engineHeartbeatAt: string | null;
}

/* ----------------------- Execution / Phase 2 ----------------------- */

/** execution_sessions.status values. Mirrored in schema CHECK + constants. */
export type SessionStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted"
  | "paused";

/** execution_events.type values. Mirrored in schema CHECK + constants. */
export type ExecutionEventType =
  | "task_started"
  | "session_started"
  | "message"
  | "tool_call"
  | "tool_result"
  | "approval_requested"
  | "approval_resolved"
  | "task_completed"
  | "task_failed"
  | "error"
  | "usage"
  | "session_aborted"
  | "unknown";

/** artifacts.kind values. Mirrored in schema CHECK + constants. */
export type ArtifactKind = "diff" | "file_list" | "result" | "other";

/** approval_requests.kind values. */
export type ApprovalKind = "permission" | "question";

/** approval_requests.status values. */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "replied"
  | "cancelled";

/** notifications.type values. */
export type NotificationType = "approval" | "completion" | "failure" | "system";

/** Consolidated token/cost counters (from a session or usage record). */
export interface CostSummary {
  total: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  /**
   * Additive (Phase 5 decision Q12): true when ANY usage record aggregated into
   * this summary was flagged `estimated` (i.e. an Ollama local run priced from a
   * settings table — never a provider-reported cost). Absent/false ⇒ all
   * provider-reported (OpenCode). Optional so existing consumers are unaffected.
   */
  estimated?: boolean;
}

/**
 * A house's aggregate usage across all its sessions (SUM over usage_records).
 * `total` is the accumulated cost; `sessions` counts the usage records.
 */
export interface HouseUsageSummary extends CostSummary {
  sessions: number;
}

export interface ExecutionSessionDto {
  id: Id;
  taskId: Id;
  houseId: Id;
  agentId: Id | null;
  providerSessionId: string | null;
  status: SessionStatus;
  provider: string;
  modelId: string;
  directory: string | null;
  lastError: string | null;
  costTotal: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ExecutionEventDto {
  id: number;
  sessionId: Id | null;
  taskId: Id | null;
  houseId: Id | null;
  rawType: string;
  type: ExecutionEventType;
  payload: Record<string, unknown>;
  createdAt: IsoTimestamp;
}

export interface AgentMessageDto {
  id: Id;
  sessionId: Id;
  role: "user" | "agent" | "tool";
  content: string;
  createdAt: IsoTimestamp;
}

export interface ApproveOption {
  id: string;
  label: string;
}

export interface ApprovalRequestDto {
  id: Id;
  sessionId: Id;
  taskId: Id | null;
  houseId: Id | null;
  providerRequestId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  title: string;
  message: string;
  options: ApproveOption[];
  response: string | null;
  createdAt: IsoTimestamp;
  respondedAt: IsoTimestamp | null;
  /** Engine-only outbound marker: set once the user's action was relayed to the provider. */
  relayedAt: IsoTimestamp | null;
}

export interface NotificationDto {
  id: Id;
  type: NotificationType;
  title: string;
  body: string;
  houseId: Id | null;
  taskId: Id | null;
  approvalRequestId: Id | null;
  read: boolean;
  createdAt: IsoTimestamp;
}

export interface ArtifactDto {
  id: Id;
  sessionId: Id;
  taskId: Id | null;
  kind: ArtifactKind;
  content: string;
  createdAt: IsoTimestamp;
}

/** Derived runtime status for a house (from its active session, not stored). */
export type HouseRuntimeStatus =
  | "idle"
  | "planning"
  | "working"
  | "awaiting_approval"
  | "awaiting_input"
  | "paused";

/** HouseDto extended with Phase 2 runtime detail. */
export interface HouseDetailDto extends HouseDto {
  runtimeStatus: HouseRuntimeStatus;
  activeTask: {
    id: Id | null;
    title: string | null;
    status: TaskStatus | null;
  };
  pendingApprovals: number;
  /** Aggregated usage across all of a house's sessions (Phase 3). */
  usage: HouseUsageSummary;
  /** Derived High Lord plan state (present on high_lord houses only — addendum D4f). */
  planState?: HighLordPlanState;
}

/* --------------------------- Realtime / SSE ------------------------- */

/**
 * RealtimeEvent union. Phase 1 emits a `hello` handshake; Phase 2 additionally
 * pushes execution-event and notification feed payloads from /api/stream's
 * change-feed tick.
 */
export type RealtimeEvent =
  | { type: "hello"; cursor: number }
  | { type: "event"; event: ExecutionEventDto }
  | { type: "notification"; notification: NotificationDto };

/* ---------------------- High Lord planning / Phase 4 ----------------- */

/** subtasks.status values (echoed by ck_subtasks_status). */
export type SubtaskStatus =
  | "planned"
  | "ready"
  | "delegated"
  | "in_flight"
  | "completed"
  | "failed"
  | "cancelled";

/** A single subtask row surfaced to the Court UI. */
export interface SubtaskDto {
  id: Id; // subtasks.id
  parentTaskId: Id;
  taskId: Id | null; // child task row (null until delegation)
  orderIndex: number;
  dependsOn: string[]; // plan-local ids (stable for UI keys/edges)
  planId: string; // plan-local id ("s0") — stored in dependsOn
  status: SubtaskStatus;
  attemptCount: number;
  title: string;
  instructions: string;
  completionRequirements: string;
  houseId: Id | null; // resolved destination
  houseName: string | null; // denormalized for the UI (join)
  childTaskStatus: TaskStatus | null; // tasks.status of the child row
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** A handoff row (High Lord → executor) surfaced to the Court UI. */
export interface HandoffDto {
  id: Id;
  subtaskId: Id;
  sourceHouseId: Id | null;
  destinationHouseId: Id | null;
  instructions: string;
  context: Record<string, unknown>;
  artifacts: string[];
  completionRequirements: string;
  createdAt: IsoTimestamp;
}

/** Consolidated result block present on a PlanDto when the parent is terminal. */
export interface PlanConsolidatedResult {
  summary: string | null;
  fileCount: number;
  diffPreview: string | null;
}

/** The full plan DTO for a parent task's Court board. */
export interface PlanDto {
  parentTaskId: Id;
  parentTask: TaskDto;
  subtasks: SubtaskDto[];
  handoffs: HandoffDto[];
  cost: CostSummary; // rollup across child usage_records
  consolidated: PlanConsolidatedResult | null; // present when parent is terminal
}

/** Court chat history item. */
export interface CourtMessageDto {
  id: Id;
  role: "user" | "agent";
  content: string;
  createdAt: IsoTimestamp;
  taskId: Id | null;
}

/** Derived plan state on the High Lord's latest parent task (additive enrichment). */
export type HighLordPlanState =
  | "idle"
  | "planning"
  | "active"
  | "aborted"
  | "completed";

/* ---------------------------- Audit log / Phase 6 ------------------- */

/**
 * audit_log.actor values (echoed by ck_audit_actor). The web process writes
 * `user` action rows; `engine` is reserved for an additive engine-owned set
 * (execution lifecycle stays in execution_events, not here).
 */
export type AuditActor = "user" | "engine";

/**
 * audit_log.entity_type values. Deliberately NOT a CHECK constraint (the
 * column is extensible) so a new audited entity never forces a table rebuild;
 * this union + AUDIT_ENTITY_TYPES list the known set surfaced by the UI.
 * `task` is absent because no task CRUD is audited (see AUDIT_ENTITY_TYPES).
 */
export type AuditEntityType =
  | "house"
  | "agent"
  | "project"
  | "provider_config"
  | "approval"
  | "template";

/** A single append-only audit entry surfaced to Settings. */
export interface AuditLogDto {
  id: Id;
  actor: AuditActor;
  actorAgentId: Id | null;
  /** Free text ('create'|'update'|'delete'|'status'|'respond'|…), no CHECK. */
  action: string;
  entityType: AuditEntityType;
  entityId: Id | null;
  metadata: Record<string, unknown>;
  createdAt: IsoTimestamp;
}

/* --------------------------- Templates / Phase 6 C ------------------ */

/**
 * templates.kind values (echoed by ck_templates_kind + TEMPLATE_KINDS).
 * A house template's payload is a houseCreateSchema minus the name (which is
 * instantiation-supplied); a project template's payload is description +
 * defaultModel + instructions (the directory is supplied at instantiation).
 */
export type TemplateKind = "house" | "project";

/** Stored/returned payload for a HOUSE template (validated by houseCreateSchema). */
export interface HouseTemplatePayload {
  description: string;
  agent: HouseAgent;
  configuration: HouseConfiguration;
}

/** Stored/returned payload for a PROJECT template (Q4: no allowlist). */
export interface ProjectTemplatePayload {
  description: string;
  defaultModel: string | null;
  instructions: string | null;
}

/** A reusable house/project template row surfaced to the API/UI. */
export interface TemplateDto {
  id: Id;
  kind: TemplateKind;
  name: string;
  description: string;
  /** Kind-specific payload; parsed JSON. See HouseTemplatePayload/ProjectTemplatePayload. */
  payload: HouseTemplatePayload | ProjectTemplatePayload;
  /** True for boot-seeded defaults, which are immutable via the API. */
  isSeeded: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/* --------------------------- Archives / Phase 6 D ------------------- */

/**
 * A read-only archive search result: one terminal task joined to its house and
 * aggregated execution info. No new writer — pure read over tasks/sessions/
 * artifacts/messages (Q5: LIKE + indexes for 6.1; FTS5 documented as the 6.2
 * upgrade).
 */
export interface ArchiveEntryDto {
  taskId: Id;
  title: string;
  status: TaskStatus;
  type: string;
  houseId: Id | null;
  houseName: string | null;
  /** Number of execution sessions recorded for this task. */
  sessionCount: number;
  /** SUM of the task's usage_records cost (0 when none). */
  cost: number;
  /** Best-effort first line of the task description or a result artifact. */
  summarySnippet: string;
  createdAt: IsoTimestamp;
}

/** Parsed/validated archive query (see archiveQuerySchema). */
export interface ArchiveQuery {
  q?: string;
  houseId?: Id;
  status?: TaskStatus;
  type?: string;
  from?: IsoTimestamp;
  to?: IsoTimestamp;
  limit: number;
  offset: number;
}

/* --------------------------- Usage / Phase 6 E ---------------------- */

/**
 * Estimated-vs-provider-reported cost split plus token counters, aggregated
 * over `usage_records` ONLY. The session mirror (`execution_sessions.*`) is
 * deliberately never summed here — each terminal session writes exactly one
 * usage row, so adding both would double-count (plan §16 risk 4).
 *
 * Invariant: `totalCost === estimatedCost + reportedCost`.
 */
export interface UsageTotalsDto {
  /** SUM(cost) over every matched usage row. */
  totalCost: number;
  /** SUM(cost) where estimated=1 (Ollama local pricing). */
  estimatedCost: number;
  /** SUM(cost) where estimated=0 (provider-reported, e.g. OpenCode). */
  reportedCost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  /** Count of matched usage rows (one per terminal session). */
  sessions: number;
}

/**
 * One grouped row in a usage breakdown (per house / per model / per task).
 * Carries the estimated/reported split so a stacked bar can render it.
 */
export interface UsageBreakdownDto {
  /** Stable group key: houseId | `${provider}/${modelId}` | taskId. */
  key: string;
  /** Human label: house name | provider/modelId | task title. */
  label: string;
  houseId: Id | null;
  taskId: Id | null;
  provider: string | null;
  modelId: string | null;
  totalCost: number;
  estimatedCost: number;
  reportedCost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  sessions: number;
  /** True when ANY row in the group was an Ollama estimate. */
  estimated: boolean;
}

/** One time bucket in the usage series (day or hour). */
export interface UsageSeriesPointDto {
  /** ISO day `YYYY-MM-DD` or hour `YYYY-MM-DDTHH` (lexical bucket key). */
  bucket: string;
  totalCost: number;
  estimatedCost: number;
  reportedCost: number;
  inputTokens: number;
  outputTokens: number;
}

/** Dashboard payload returned by GET /api/usage. */
export interface UsageDashboardDto {
  totals: UsageTotalsDto;
  byHouse: UsageBreakdownDto[];
  byModel: UsageBreakdownDto[];
  /** Top tasks by cost (bounded) — the per-task breakdown. */
  byTask: UsageBreakdownDto[];
  /** Cost/token series ordered oldest→newest for the sparkline. */
  series: UsageSeriesPointDto[];
  bucket: "day" | "hour";
  /** ISO timestamp the aggregate was computed (for an "as of" label). */
  generatedAt: IsoTimestamp;
}

/* ------------------------- Monitoring / Phase 6 F ------------------- */

/** Derived engine liveness from the persisted heartbeat. */
export type EngineHealth = "online" | "stale" | "offline";

/**
 * Read-only engine/queue/error monitoring payload (Phase 6 Stage F). Pure read
 * over `engine_state`, `tasks`, `execution_events` plus a best-effort OpenCode
 * health probe. `providerHealth` is false when the server is unreachable.
 */
export interface MonitoringDto {
  engineHeartbeatAt: IsoTimestamp | null;
  /** Age of the heartbeat in ms; null when the engine has never run. */
  heartbeatAgeMs: number | null;
  engineVersion: string | null;
  opencodeServerPid: string | null;
  /** tasks.status='queued'. */
  queueDepth: number;
  /** tasks.status='running'. */
  runningCount: number;
  /** execution_events type='error' in the last 24h. */
  errorsLast24h: number;
  /** execution_events type='task_failed' in the last 24h. */
  failuresLast24h: number;
  /** All execution_events in the last 24h. */
  eventsLast24h: number;
  /** Best-effort OpenCode GET /api/health (false when unreachable). */
  providerHealth: boolean;
  /** Server-derived liveness so the UI/tests agree on the threshold. */
  engineHealth: EngineHealth;
  /** ISO timestamp the payload was computed. */
  checkedAt: IsoTimestamp;
}

/* --------------------------- UI preferences ------------------------- */

export interface StoredTaskTypes {
  /** Union of defaults + user-added custom types. */
  types: string[];
}

export interface StoredAppearance {
  /** Disables heavy animations globally. */
  reducedMotion: boolean;
}
