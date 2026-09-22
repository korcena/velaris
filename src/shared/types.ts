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

/** The full House DTO returned by the API (embeds agent + configuration). */
export interface HouseDto {
  id: Id;
  name: string;
  description: string | null;
  status: HouseStatus;
  agent: HouseAgent;
  configuration: HouseConfiguration;
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
  | "interrupted";

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
  | "interrupted";

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
  role: "user" | "agent";
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
  | "awaiting_input";

/** HouseDto extended with Phase 2 runtime detail. */
export interface HouseDetailDto extends HouseDto {
  runtimeStatus: HouseRuntimeStatus;
  activeTask: {
    id: Id | null;
    title: string | null;
    status: TaskStatus | null;
  };
  pendingApprovals: number;
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

/* --------------------------- UI preferences ------------------------- */

export interface StoredTaskTypes {
  /** Union of defaults + user-added custom types. */
  types: string[];
}

export interface StoredAppearance {
  /** Disables heavy animations globally. */
  reducedMotion: boolean;
}
