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

/** Phase 1 task statuses. Phase 2 extends this enum. */
export type TaskStatus = "queued" | "cancelled";

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

/* --------------------------- Realtime / SSE ------------------------- */

/**
 * RealtimeEvent union. Phase 1 only emits a `hello` handshake; Phase 2 wires
 * the change feed into this stream.
 */
export type RealtimeEvent =
  | { type: "hello"; cursor: number }
  | { type: "event"; event: unknown };

/* --------------------------- UI preferences ------------------------- */

export interface StoredTaskTypes {
  /** Union of defaults + user-added custom types. */
  types: string[];
}

export interface StoredAppearance {
  /** Disables heavy animations globally. */
  reducedMotion: boolean;
}
