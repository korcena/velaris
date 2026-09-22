/**
 * OpenCode client shared types — the subset of the OpenCode v1.18.31 OpenAPI
 * we build against (pinned, verified shapes). Tolerantly shaped so drifted /
 * unknown fields never crash the mapper.
 */

export interface SessionInfo {
  id: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
  };
  model: { id: string; providerID: string };
  time: { created: number; updated: number };
  title: string;
}

export interface SessionDiffEntry {
  file?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: "added" | "deleted" | "modified";
}

export interface PermissionRequest {
  id: string;
  sessionID?: string;
  /** The resource/action string OpenCode described, e.g. "write" or a path. */
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID?: string; callID?: string };
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID?: string;
  questions: QuestionInfo[];
  tool?: { messageID?: string; callID?: string };
}

/**
 * A raw event emitted by GET /event?directory=...
 * We keep `type` and `properties` per the verified shape and tolerate any
 * unknown type. `id` may or may not be present depending on the event kind.
 */
export interface ProviderEvent {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}
