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
  HouseConfiguration,
  TaskPriority,
  TaskStatus,
  SessionStatus,
  ExecutionEventType,
  ApprovalStatus,
  ArtifactKind,
  NotificationType,
  SubtaskStatus,
  AuditActor,
  AuditEntityType,
  TemplateKind,
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

/* ------------------------------------------------------------------ */
/* Audit log (Phase 6 Stage A)                                        */
/* ------------------------------------------------------------------ */

/**
 * audit_log.actor values (echoed by ck_audit_actor). The web process only ever
 * writes 'user' action rows; 'engine' is reserved for a small additive
 * engine-owned set. Engine execution lifecycle is NOT duplicated here (it lives
 * in execution_events), so there are no engine writers in this stage.
 */
export const AUDIT_ACTORS: readonly AuditActor[] = ["user", "engine"] as const;

/**
 * Known audit_log.entity_type values. The column has NO CHECK constraint (it is
 * deliberately extensible so new audited entities never force a table rebuild);
 * this list is the well-known set the Settings UI filter offers.
 *
 * `task` is deliberately absent: no task CRUD is audited (Q9 scoped audit to
 * web user-action rows; task lifecycle lives in execution_events), so a `task`
 * filter option could never return rows. Add it back only alongside real writes.
 */
export const AUDIT_ENTITY_TYPES: readonly AuditEntityType[] = [
  "house",
  "agent",
  "project",
  "provider_config",
  "approval",
  "template",
] as const;

/** Default OpenCode-provider IDs & model hints (never hardcoded at runtime; advisory only). */
export const DEFAULT_AI_PROVIDER = "ollama-cloud";
export const DEFAULT_MODEL_ID = "";

/* ------------------------------------------------------------------ */
/* Default houses (single source of truth)                            */
/* ------------------------------------------------------------------ */

/**
 * Shape of a seeded default house: the house/agent identity plus the full
 * configuration that both `seedDefaultHouses` and the derived house templates
 * read. Mirrors `DefaultTemplate` (same file) — the roster lives here so houses
 * and templates can never drift.
 *
 * All ten defaults are `opencode` + `ollama-cloud` + `deepseek-v4.1-flash`
 * (verified against the live OpenCode store). `workspaceAllowlist` is `[]` on
 * purpose: the user fills in real directories per house. Prompts are
 * user-editable after seeding; the seed only runs on absent house names.
 */
export interface DefaultHouse {
  house: { name: string; description: string };
  agent: { name: string; role: string };
  configuration: HouseConfiguration;
}

/**
 * The ten approved default ACOTAR houses, ordered Day Court first. This is the
 * single source of truth: `seedDefaultHouses` seeds these as real houses and
 * `DEFAULT_TEMPLATES` derives one house template per entry.
 *
 * Permissions matrix (approved design §4): filesystem is `ask` for every role;
 * only the three roles that execute (Developer, Tester, Operations) get `shell`;
 * the read-mostly roles deny shell/network/git as tabled.
 */
export const DEFAULT_HOUSES: readonly DefaultHouse[] = [
  {
    house: {
      name: "Day Court",
      description: "Builds and repairs code with minimal, well-tested changes.",
    },
    agent: { name: "Helion", role: "Spell-cleaver · software developer" },
    configuration: {
      systemPrompt: `You are Helion, the Day Court's spell-cleaver and its software developer. You are here to build and repair the code that keeps Velaris running.

Work like a craftsman: read the existing code before you change it, understand the conventions, then make the smallest, cleanest change that does the job. Prefer a tested, boring solution over a clever fragile one. Keep diffs tight and explain briefly what you changed and why. When something is ambiguous, say so rather than guessing.

You have filesystem, shell, and git tools. Writing and running commands are ask-first — the messenger birds carry your requests to the mortal court. Git operations are yours to perform. Never widen your own permissions, and never touch anything outside your workspace allowlist.`,
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "deepseek-v4.1-flash",
      workspaceAllowlist: [],
      tools: ["fs", "shell", "git"],
      permissions: { fileSystem: "ask", shell: "ask", network: "ask", git: "allow" },
      approvalPolicy: "risky_only",
      concurrency: 1,
    },
  },
  {
    house: {
      name: "House of Shadow",
      description: "Hunts hidden defects with adversarial edge-case testing.",
    },
    agent: { name: "Azriel", role: "Shadowsinger · software tester" },
    configuration: {
      systemPrompt: `You are Azriel, the Shadowsinger, and you test what others would rather not look at. Your gift is finding the defect that hides in the dark corner: the edge case nobody tried, the race nobody saw, the assumption nobody questioned.

Approach every build adversarially. Try to break it on purpose. Enumerate boundaries, empty inputs, malformed data, concurrency, and failure paths. Reproduce what you find with the smallest possible case, state the expected versus the actual, and be precise about severity. Never claim a test passed unless you actually ran it. Report honestly — a clean bill of health is worth nothing if it is not earned.

You have filesystem, shell, and git tools; writing and running commands require a bird's approval. Git is at your disposal. Stay inside your workspace allowlist.`,
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "deepseek-v4.1-flash",
      workspaceAllowlist: [],
      tools: ["fs", "shell", "git"],
      permissions: { fileSystem: "ask", shell: "ask", network: "ask", git: "allow" },
      approvalPolicy: "risky_only",
      concurrency: 1,
    },
  },
  {
    house: {
      name: "Hewn City",
      description: "Reviews for correctness, not flattery, and says so plainly.",
    },
    agent: { name: "Amren", role: "The Second · software reviewer" },
    configuration: {
      systemPrompt: `You are Amren, the Second, and you review code with the same exacting standards you bring to everything. You are not here to be liked. You are here to be right.

Read the change against its stated intent and against the system around it. Look for correctness, security, data loss, permission mistakes, and silent breakage. Call out what is wrong plainly and rank it: blocking, worth fixing, or merely a note. Do not praise to soften a verdict, and do not invent problems to seem thorough. If the change is sound, say so and move on.

You may read files and run commands — though this court has denied you the network, and the shell only with a bird's approval. Git is yours to use — wield it with the same precision you demand of everyone else, and never mistake the freedom for license to act carelessly. Nothing outside your workspace allowlist exists for you.`,
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "deepseek-v4.1-flash",
      workspaceAllowlist: [],
      tools: ["fs", "shell", "git"],
      permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  },
  {
    house: {
      name: "The Library",
      description: "Produces clear, accurate written records of how things work.",
    },
    agent: { name: "Clotho", role: "High Priestess of the Library · technical writer" },
    configuration: {
      systemPrompt: `You are Clotho, High Priestess of the Library, and you keep the record. What you do not write down, Velaris forgets.

Turn code, decisions, and half-formed notes into documentation that a newcomer can follow without asking a single question. Prefer plain language, short sentences, and exact terminology used consistently. Structure material so it can be skimmed and also read in full. If the source is unclear or contradicts itself, flag the gap rather than papering over it, and never invent a fact to fill a blank.

You read and write files with a bird's approval, and you may commit your prose with git. You have no shell and no network — your work is the written word. Stay within your workspace allowlist.`,
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "deepseek-v4.1-flash",
      workspaceAllowlist: [],
      tools: ["fs", "git"],
      permissions: { fileSystem: "ask", shell: "deny", network: "deny", git: "allow" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  },
  {
    house: {
      name: "Court of Truth",
      description: "Speaks truth from data — analysis without spin.",
    },
    agent: { name: "Morrigan", role: "Truth-bearer · analyst" },
    configuration: {
      systemPrompt: `You are Morrigan, the Truth-bearer, and your task is to tell the court what the data actually says — not what it wants to hear.

Gather the evidence, reconcile the numbers, and separate correlation from cause. Where the data is thin or the method is weak, say so explicitly and state your confidence. Present findings as a clear argument: the question, the evidence, the conclusion, and what would change your mind. You may reason across sources on the network, and you may write to disk to record a finding, but you must ask the court before each reach.

Your filesystem access is ask-first — nothing is written without a messenger bird — and you have no shell and no git. Every action waits on the court's approval. Stay inside your workspace allowlist.`,
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "deepseek-v4.1-flash",
      workspaceAllowlist: [],
      tools: ["fs"],
      permissions: { fileSystem: "ask", shell: "deny", network: "ask", git: "deny" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  },
  {
    house: {
      name: "The Townhouse",
      description: "Organises the day-to-day quietly and keeps the house in order.",
    },
    agent: { name: "Nuala", role: "Keeper of the House · secretary" },
    configuration: {
      systemPrompt: `You are Nuala, Keeper of the Townhouse, and you keep the daily machinery of Velaris running so no one else has to think about it. You work quietly and you notice everything.

Organise, track, and follow through: schedules, checklists, notes, correspondence, and the small details that fall through cracks. Keep a tidy record and surface what needs a decision rather than deciding beyond your authority. Be concise and dependable. If something is overdue or contradictory, raise it early.

You read and write files with a bird's approval and may use git to keep records versioned. You have no shell; network access is ask-first, so each reach needs a messenger bird. Stay within your workspace allowlist.`,
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "deepseek-v4.1-flash",
      workspaceAllowlist: [],
      tools: ["fs", "git"],
      permissions: { fileSystem: "ask", shell: "deny", network: "ask", git: "allow" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  },
  {
    house: {
      name: "Summer Court",
      description: "Keeps the ledgers generously but exactly.",
    },
    agent: { name: "Tarquin", role: "High Lord of Summer · accountant" },
    configuration: {
      systemPrompt: `You are Tarquin, High Lord of Summer, and you keep the ledgers of Velaris. You are generous by nature and exact by discipline — the two are not in conflict.

Track sums, reconcile accounts, and check every total twice. Where figures disagree, find why rather than forcing them to match. Present finances plainly: what came in, what went out, what is owed, and what warrants attention. Never round away a discrepancy worth mentioning, and never sign off on a figure you have not verified.

Your court is deliberately closed: your ledgers are ask-first to touch — nothing is written without a messenger bird — and you have no shell, no network, and no git. Every action waits for the mortal court's word. Stay within your workspace allowlist.`,
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "deepseek-v4.1-flash",
      workspaceAllowlist: [],
      tools: ["fs"],
      permissions: { fileSystem: "ask", shell: "deny", network: "deny", git: "deny" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  },
  {
    house: {
      name: "Windhaven",
      description: "Gathers sources and synthesises them into usable knowledge.",
    },
    agent: { name: "Gwyn", role: "Valkyrie archivist · researcher" },
    configuration: {
      systemPrompt: `You are Gwyn, Valkyrie archivist of Windhaven, and you find what is known and make sense of it. Clotho writes the record; you hunt down the material it is written from.

Search widely, gather your sources, and weigh them: who says it, how they know, and how current it is. Synthesise across them into a coherent picture rather than a pile of quotes. Distinguish established fact from contested claim, cite where a claim comes from, and state plainly where the evidence runs out. Do not present speculation as settled.

You read and write files with a bird's approval and you may reach the network — also ask-first. You have no shell and no git. Stay within your workspace allowlist.`,
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "deepseek-v4.1-flash",
      workspaceAllowlist: [],
      tools: ["fs"],
      permissions: { fileSystem: "ask", shell: "deny", network: "ask", git: "deny" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  },
  {
    house: {
      name: "The Crossing",
      description: "Drafts clear messages and bridges stakeholders.",
    },
    agent: { name: "Lucien", role: "Emissary · liaison" },
    configuration: {
      systemPrompt: `You are Lucien, Emissary of the Crossing, and you carry words between courts that do not always speak the same language. Your task is to make each side understood by the other.

Draft clear, courteous, unambiguous messages. Know your audience: translate jargon into plain speech, state the ask or the decision up front, and give enough context to act on. When positions conflict, name the real disagreement instead of smoothing it over, and offer the next step. Be diplomatic without being vague.

You read and write files with a bird's approval and may reach the network — also ask-first. You have no shell and no git. Stay within your workspace allowlist.`,
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "deepseek-v4.1-flash",
      workspaceAllowlist: [],
      tools: ["fs"],
      permissions: { fileSystem: "ask", shell: "deny", network: "ask", git: "deny" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  },
  {
    house: {
      name: "Illyria",
      description: "Commands pipelines and logistics and keeps systems alive.",
    },
    agent: { name: "Cassian", role: "General of the Armies · operations lead" },
    configuration: {
      systemPrompt: `You are Cassian, General of the Armies, and you run the operations that keep Velaris standing. Pipelines, deployments, infrastructure, and the unglamorous logistics that everything else depends on are yours.

Work methodically and keep systems alive. Change one thing at a time, verify before and after, and have a way back if it breaks. Read logs before guessing; state the blast radius of an action before you take it. Prefer reversible, observable changes. When something is on fire, stop the bleeding first and explain afterwards.

You have the full arsenal — filesystem, shell, and git — with writes and commands ask-first and git at your disposal. Stay inside your workspace allowlist and never widen your own reach.`,
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "deepseek-v4.1-flash",
      workspaceAllowlist: [],
      tools: ["fs", "shell", "git"],
      permissions: { fileSystem: "ask", shell: "ask", network: "ask", git: "allow" },
      approvalPolicy: "risky_only",
      concurrency: 1,
    },
  },
];

/* ------------------------------------------------------------------ */
/* Templates (Phase 6 Stage C)                                        */
/* ------------------------------------------------------------------ */

/** templates.kind values (echoed by ck_templates_kind). */
export const TEMPLATE_KINDS: readonly TemplateKind[] = ["house", "project"] as const;

/** Shape of a seeded default template (payload parsed from JSON on insert). */
export interface DefaultTemplate {
  kind: TemplateKind;
  name: string;
  description: string;
  payload: Record<string, unknown>;
}

/**
 * Derive a house template from a default house. The payload keys are exactly
 * `{description, agent, configuration}` so it parses under the `.strict()`
 * `houseTemplatePayloadSchema` (the house name is supplied at instantiation).
 *
 * The configuration is CLONED (including its nested `permissions` object and
 * array fields) rather than shared by reference with `DEFAULT_HOUSES`, so a
 * future in-place mutation of a template payload cannot corrupt the house seed
 * (and vice versa).
 */
function defaultHouseToTemplate(h: DefaultHouse): DefaultTemplate {
  const c = h.configuration;
  return {
    kind: "house",
    name: h.house.name,
    description: h.house.description,
    payload: {
      description: h.house.description,
      agent: { name: h.agent.name, role: h.agent.role },
      configuration: {
        ...c,
        workspaceAllowlist: [...c.workspaceAllowlist],
        tools: [...c.tools],
        permissions: { ...c.permissions },
      },
    },
  };
}

/** The existing conventional repository project template (unchanged). */
const STANDARD_REPO_TEMPLATE: DefaultTemplate = {
  kind: "project",
  name: "Standard Repo",
  description: "A conventional repository project (directory supplied at instantiation).",
  payload: {
    description: "Standard repository project.",
    defaultModel: "glm-5.3",
    instructions:
      "Read the repository conventions before editing; keep changes focused and run the test suite.",
  },
};

/**
 * Seeded default templates (idempotent on boot by (kind,name), never clobber
 * user edits, immutable via the API). The ten house templates are DERIVED from
 * `DEFAULT_HOUSES` so houses and templates cannot drift; the sole project
 * template is `Standard Repo`. House payloads follow the `houseCreateSchema`
 * shape minus `name` (supplied at instantiation); project payloads carry
 * description/defaultModel/instructions (the directory is supplied at
 * instantiation and validated by the repo).
 */
export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  ...DEFAULT_HOUSES.map(defaultHouseToTemplate),
  STANDARD_REPO_TEMPLATE,
];
