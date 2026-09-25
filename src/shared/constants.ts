/**
 * Shared constants for Velaris.
 *
 * This module is imported by BOTH the web process (Next.js) and the engine
 * process (plain Node via tsx). It must therefore contain NO Next.js or React
 * imports and no server-only utilities.
 */

import type {
  HouseStatus,
  HouseKind,
  TaskPriority,
  TaskStatus,
  SessionStatus,
  ExecutionEventType,
  ApprovalStatus,
  ArtifactKind,
  NotificationType,
  SubtaskStatus,
} from "./types";

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

export interface NavSection {
  /** Stable slug used as the path ("" maps to "/"). */
  path: string;
  /** Fantasy title shown in the sidebar. */
  name: string;
  /** Short functional subtitle describing what this section does. */
  subtitle: string;
  /** Lucide icon name. */
  icon: string;
}

/** The 9 Velaris navigation sections. */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    path: "",
    name: "Velaris",
    subtitle: "The city at night — overview",
    icon: "Sparkles",
  },
  {
    path: "/map",
    name: "Map",
    subtitle: "The city at a glance",
    icon: "Map",
  },
  {
    path: "/high-lord",
    name: "High Lord's Court",
    subtitle: "The orchestrator — planning & delegation (Phase 4)",
    icon: "Crown",
  },
  {
    path: "/houses",
    name: "The Houses",
    subtitle: "Your agents — identity, tools & permissions",
    icon: "Castle",
  },
  {
    path: "/quests",
    name: "Quest Board",
    subtitle: "Tasks & work items for the houses",
    icon: "ScrollText",
  },
  {
    path: "/roost",
    name: "Messenger Roost",
    subtitle: "Approvals & clarifications",
    icon: "Bird",
  },
  {
    path: "/archives",
    name: "Archives",
    subtitle: "Completed work & history (Phase 6)",
    icon: "Library",
  },
  {
    path: "/projects",
    name: "Projects",
    subtitle: "Working directories & repositories",
    icon: "FolderKanban",
  },
  {
    path: "/settings",
    name: "Settings",
    subtitle: "Providers, task types & appearance",
    icon: "Settings",
  },
] as const;

/* ------------------------------------------------------------------ */
/* Status enums (source of truth — see ARCHITECTURE §6.3)              */
/* ------------------------------------------------------------------ */

/** House config status (stored on the houses row). */
export const HOUSE_STATUSES: readonly HouseStatus[] = [
  "active",
  "disabled",
  "archived",
] as const;

/** Task priority levels. */
export const TASK_PRIORITIES: readonly TaskPriority[] = [
  "low",
  "medium",
  "high",
  "urgent",
] as const;

/** Task statuses (Phase 2 full set — echoed by the tasks CHECK constraint). */
export const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "paused",
] as const;

/** execution_sessions.status values (echoed by ck_execution_sessions_status). */
export const SESSION_STATUSES: readonly SessionStatus[] = [
  "pending",
  "running",
  "awaiting_approval",
  "awaiting_input",
  "completed",
  "failed",
  "aborted",
  "interrupted",
  "paused",
] as const;

/** execution_events.type values (echoed by ck_execution_events_type). */
export const EXECUTION_EVENT_TYPES: readonly ExecutionEventType[] = [
  "task_started",
  "session_started",
  "message",
  "tool_call",
  "tool_result",
  "approval_requested",
  "approval_resolved",
  "task_completed",
  "task_failed",
  "error",
  "usage",
  "session_aborted",
  "unknown",
] as const;

/** approval_requests.status values (echoed by ck_approvals_status). */
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "replied",
  "cancelled",
] as const;

/** approval_requests.kind values (echoed by ck_approvals_kind). */
export const APPROVAL_KINDS: readonly ["permission", "question"] = [
  "permission",
  "question",
] as const;

/** agent_messages.role values (echoed by ck_agent_messages_role). */
export const AGENT_MESSAGE_ROLES: readonly ["user", "agent", "tool"] = [
  "user",
  "agent",
  "tool",
] as const;

/** artifacts.kind values (echoed by ck_artifacts_kind). */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "diff",
  "file_list",
  "result",
  "other",
] as const;

/** notifications.type values (echoed by ck_notifications_type). */
export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  "approval",
  "completion",
  "failure",
  "system",
] as const;

/* ------------------------------------------------------------------ */
/* Task types                                                          */
/* ------------------------------------------------------------------ */

/**
 * Default task types. `type` on the tasks table is an extensible string, so
 * users may add arbitrary custom types in Settings; these are just the
 * well-known initial set.
 */
export const DEFAULT_TASK_TYPES: readonly string[] = [
  "new_project",
  "bug_fix",
  "research",
  "documentation",
  "planning",
  "analysis",
  "creative",
  "general",
] as const;

/* ------------------------------------------------------------------ */
/* High Lord orchestration / Phase 4                                  */
/* ------------------------------------------------------------------ */

/** houses.kind values (echoed by ck_houses_kind). */
export const HOUSE_KINDS: readonly HouseKind[] = ["agent", "high_lord"] as const;

/** subtasks.status values (echoed by ck_subtasks_status). */
export const SUBTASK_STATUSES: readonly SubtaskStatus[] = [
  "planned",
  "ready",
  "delegated",
  "in_flight",
  "completed",
  "failed",
  "cancelled",
] as const;

/**
 * Loop safeguards (configurable later via the High Lord's house edit →
 * executionPreferences).
 */
export const ORCHESTRATION_DEFAULTS = {
  MAX_SUBTASKS: 8,
  /** Total runs per subtask = 1 + MAX_SUBTASK_RETRIES. Replaces escalation. */
  MAX_SUBTASK_RETRIES: 3,
  /** Total plan budget (input+output) via usage_records rollup. */
  PLAN_TOKEN_BUDGET: 400_000,
} as const;

/** Seeded High Lord house identity (used by web+engine boot seeds). */
export const HIGH_LORD_SEED = {
  HOUSE_NAME: "High Lord",
  HOUSE_DESCRIPTION: "Velaris' orchestrator — plans, delegates, consolidates.",
  AGENT_NAME: "Rhysand",
  AGENT_ROLE: "High Lord · orchestrator",
  /**
   * Seeded High Lord configuration. Editable by the user via the standard house
   * form — the seed only runs on absent rows, never clobbers user edits.
   */
  CONFIGURATION: {
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    approvalPolicy: "never", // auto-approve so a planning call never blocks
    concurrency: 1,
  } as const,
  /**
   * Planning system prompt template. Editable by the user via the standard
   * house edit form; the roster is appended per-run by the orchestrator so
   * models/roster drift between runs is fine.
   */
  SYSTEM_PROMPT: `You are Rhysand, High Lord of the Velaris court and its orchestrator.

You receive a single instruction from the mortal court. Your job is to decompose it
into a concrete plan of subtasks that the houses of Velaris can execute in parallel
where possible, honouring dependencies.

You MUST reply with STRICT JSON ONLY — no prose, no markdown fences. The JSON must
match exactly this shape:

{
  "subtasks": [
    {
      "id": "s0",
      "title": "Short imperative title",
      "description": "Optional detail",
      "type": "general",
      "houseId": null,
      "houseHints": "Optional free-text capability hints",
      "dependsOn": [],
      "instructions": "Precise, self-contained execution instructions",
      "context": {},
      "artifacts": [],
      "completionRequirements": ""
    }
  ]
}

Rules:
- id values are plan-local ("s0","s1",...), unique and stable.
- dependsOn references ONLY ids you define, and must form a DAG (no cycles).
- Prefer parallel, independent subtasks so different houses can work concurrently.
- Keep the plan small: at most 8 subtasks.
- houseHints is free text (skills, domain, model) — the court assigns a house.
- Each subtask's instructions must be executable by an agent without further context.`,
} as const;

/* ------------------------------------------------------------------ */
/* Provider & execution constants                                      */
/* ------------------------------------------------------------------ */

/** Execution providers supported by a house. */
export const EXECUTION_PROVIDERS: readonly ["opencode", "ollama"] = [
  "opencode",
  "ollama",
];

/** Provider config type values. */
export const PROVIDER_CONFIG_TYPES: readonly ["opencode", "ollama"] = [
  "opencode",
  "ollama",
];

/** Approval policies available for a house. */
export const APPROVAL_POLICIES: readonly ["never", "always", "risky_only"] = [
  "never",
  "always",
  "risky_only",
];

/** Per-action permission modes. */
export const PERMISSION_MODES: readonly ["allow", "ask", "deny"] = [
  "allow",
  "ask",
  "deny",
];

/** Default provider base URLs. */
export const DEFAULT_PROVIDER_BASE_URLS: Record<
  "opencode" | "ollama",
  string
> = {
  opencode: "http://127.0.0.1:4096",
  ollama: "http://localhost:11434",
};

/** Default port for spawning `opencode serve --port <p>` (opencode-server.ts). */
export const DEFAULT_OPENCODE_PORT = 4096;

/** Default OpenCode-provider IDs & model hints (never hardcoded at runtime; advisory only). */
export const DEFAULT_AI_PROVIDER = "ollama-cloud";
export const DEFAULT_MODEL_ID = "";
