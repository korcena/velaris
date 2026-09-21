/**
 * Shared constants for Velaris.
 *
 * This module is imported by BOTH the web process (Next.js) and the engine
 * process (plain Node via tsx). It must therefore contain NO Next.js or React
 * imports and no server-only utilities.
 */

import type { HouseStatus, TaskPriority, TaskStatus } from "./types";

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

/** The 8 Velaris navigation sections. */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    path: "",
    name: "Velaris",
    subtitle: "The city at night — overview",
    icon: "Sparkles",
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
    subtitle: "Approvals & clarifications (Phase 2)",
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

/** Phase 1 task statuses (execution semantics land in Phase 2). */
export const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "cancelled",
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

/** Default OpenCode-provider IDs & model hints (never hardcoded at runtime; advisory only). */
export const DEFAULT_AI_PROVIDER = "ollama-cloud";
export const DEFAULT_MODEL_ID = "";
