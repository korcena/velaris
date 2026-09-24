/**
 * OpenCode client shared types — the subset of the OpenCode v1.18.32 OpenAPI
 * we build against (pinned, live-verified shapes). Tolerantly shaped so drifted /
 * unknown fields never crash the mapper or caller.
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
  /** The provider-resolved working directory the session is actually rooted at. */
  directory?: string | null;
}

/** A single assistant part from a session transcript message. */
export interface SessionPart {
  /** Part type — one of text, reasoning, tool, step-start, step-finish, snapshot,
   * patch, file, agent, subtask, compaction, retry (unknown types tolerated). */
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/** A raw transcript message from GET /session/{id}/message. */
export interface SessionMessageRaw {
  info: { id?: string; role?: string; sessionID?: string; [k: string]: unknown };
  parts?: SessionPart[];
}

/** A normalized assistant message from a session transcript. */
export interface SessionMessage {
  /** The provider-assigned message id (used for dedupe), if present. */
  id?: string;
  role: "assistant";
  text: string;
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
