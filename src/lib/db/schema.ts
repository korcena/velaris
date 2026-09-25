/**
 * Drizzle schema — Velaris database.
 *
 * Phase 1 tables exactly per ARCHITECTURE §6.1. Tables for later phases are
 * appended in subsequent migrations (execution_sessions, execution_events,
 * approval_requests, notifications, agent_messages, artifacts, usage_records,
 * subtasks, handoffs, audit_log, engine_state ...).
 *
 * Conventions:
 *  - text uuid PKs for domain tables; INTEGER autoincrement PK for stream tables.
 *  - timestamps as ISO-8601 text.
 *  - JSON stored as text with zod-validated read/write helpers.
 *  - enum-like values as TEXT with CHECK constraints.
 */

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/sqlite-core";

/** Now(): ISO-8601 UTC string, generated in SQL so it is shared by web+engine. */
const now = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/* ------------------------------------------------------------------ */
/* houses                                                              */
/* ------------------------------------------------------------------ */

export const houses = sqliteTable(
  "houses",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").notNull().default("agent"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [
    index("idx_houses_status").on(t.status),
    check("ck_houses_name_len", sql`length(name) between 1 and 80`),
    check("ck_houses_kind", sql`kind in ('agent','high_lord')`),
    check("ck_houses_status", sql`status in ('active','disabled','archived')`),
  ],
);

/* ------------------------------------------------------------------ */
/* agents                                                              */
/* ------------------------------------------------------------------ */

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    houseId: text("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull(),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("idx_agents_house").on(t.houseId)],
);

/* ------------------------------------------------------------------ */
/* agent_configurations (1:1 with an agent in Phase 1)                */
/* ------------------------------------------------------------------ */

export const agentConfigurations = sqliteTable(
  "agent_configurations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    systemPrompt: text("system_prompt").notNull(),
    executionProvider: text("execution_provider").notNull(),
    aiProvider: text("ai_provider").notNull().default("ollama-cloud"),
    modelId: text("model_id").notNull().default(""),
    // JSON arrays as text.
    workspaceAllowlist: text("workspace_allowlist").notNull().default("[]"),
    tools: text("tools").notNull().default("[]"),
    permissions: text("permissions").notNull().default("{}"),
    approvalPolicy: text("approval_policy").notNull().default("always"),
    concurrency: integer("concurrency").notNull().default(1),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [
    // 1:1 with the agent in MVP (Phase 6 multi-agent drops this).
    uniqueIndex("idx_agent_configurations_agent").on(t.agentId),
    index("idx_agent_configurations_agent_idx").on(t.agentId),
    check("ck_config_execution_provider", sql`execution_provider in ('opencode','ollama')`),
    check("ck_config_approval_policy", sql`approval_policy in ('never','always','risky_only')`),
    check("ck_config_concurrency", sql`concurrency >= 1`),
  ],
);

/* ------------------------------------------------------------------ */
/* projects                                                            */
/* ------------------------------------------------------------------ */

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    directory: text("directory").notNull(),
    gitInfo: text("git_info").notNull().default("{}"),
    defaultAgentId: text("default_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    defaultModel: text("default_model"),
    instructions: text("instructions"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [
    uniqueIndex("idx_projects_directory").on(t.directory),
    check("ck_projects_directory_abs", sql`directory like '/%'`),
  ],
);

/* ------------------------------------------------------------------ */
/* provider_configs                                                    */
/* ------------------------------------------------------------------ */

export const providerConfigs = sqliteTable(
  "provider_configs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    baseUrl: text("base_url").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    extra: text("extra").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [
    index("idx_provider_configs_type").on(t.type),
    check("ck_provider_configs_type", sql`type in ('opencode','ollama')`),
  ],
);

/* ------------------------------------------------------------------ */
/* tasks (Phase 1 stub)                                               */
/* ------------------------------------------------------------------ */

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    type: text("type").notNull().default("general"),
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("queued"),
    houseId: text("house_id").references(() => houses.id, { onDelete: "set null" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    workingDirectory: text("working_directory"),
    executionPreferences: text("execution_preferences").notNull().default("{}"),
    attachments: text("attachments").notNull().default("[]"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [
    index("idx_tasks_house").on(t.houseId),
    index("idx_tasks_status").on(t.status),
    index("idx_tasks_project").on(t.projectId),
    check("ck_tasks_title_len", sql`length(title) between 1 and 200`),
    check("ck_tasks_priority", sql`priority in ('low','medium','high','urgent')`),
    check(
      "ck_tasks_status",
      sql`status in ('queued','running','awaiting_approval','awaiting_input','completed','failed','cancelled','interrupted','paused')`,
    ),
    check("ck_tasks_working_dir_abs", sql`working_directory is null or working_directory like '/%'`),
  ],
);

/* ------------------------------------------------------------------ */
/* engine_state (Phase 1: heartbeat only; Phase 2 adds pid/version)   */
/*                                                                     */
/* A singleton key-value row the engine upserts every few seconds and  */
/* the /api/health route reads to surface engine liveness.             */
/* ------------------------------------------------------------------ */

export const engineState = sqliteTable("engine_state", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: text("updated_at").notNull().default(now()),
});

/* ------------------------------------------------------------------ */
/* execution_sessions (Phase 2)                                       */
/* ------------------------------------------------------------------ */

export const executionSessions = sqliteTable(
  "execution_sessions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    houseId: text("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull().default("pending"),
    provider: text("provider").notNull().default("opencode"),
    modelId: text("model_id").notNull().default(""),
    directory: text("directory"),
    lastError: text("last_error"),
    costTotal: real("cost_total").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [
    uniqueIndex("idx_execution_sessions_provider").on(t.providerSessionId),
    index("idx_execution_sessions_task").on(t.taskId),
    index("idx_execution_sessions_house").on(t.houseId),
    index("idx_execution_sessions_status").on(t.status),
    check(
      "ck_execution_sessions_status",
      sql`status in ('pending','running','awaiting_approval','awaiting_input','completed','failed','aborted','interrupted','paused')`,
    ),
    check("ck_execution_sessions_provider", sql`provider in ('opencode','ollama')`),
  ],
);

/* ------------------------------------------------------------------ */
/* execution_events (Phase 2 — hot stream, INTEGER autoincrement PK)  */
/* ------------------------------------------------------------------ */

export const executionEvents = sqliteTable(
  "execution_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").references(() => executionSessions.id, {
      onDelete: "set null",
    }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    houseId: text("house_id").references(() => houses.id, { onDelete: "set null" }),
    rawType: text("raw_type").notNull().default(""),
    type: text("type").notNull().default("unknown"),
    payload: text("payload").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("idx_execution_events_session").on(t.sessionId),
    index("idx_execution_events_task").on(t.taskId),
    index("idx_execution_events_type").on(t.type),
    check(
      "ck_execution_events_type",
      sql`type in ('task_started','session_started','message','tool_call','tool_result','approval_requested','approval_resolved','task_completed','task_failed','error','usage','session_aborted','unknown')`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* agent_messages (Phase 2)                                           */
/* ------------------------------------------------------------------ */

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => executionSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** JSON `OllamaToolCall[]` on an assistant turn persisted by the tool loop.
     * OpenCode ignores this column. */
    toolCalls: text("tool_calls").notNull().default("[]"),
    /** Links a role='tool' result to the assistant tool_call that produced it. */
    toolCallId: text("tool_call_id"),
    /** Engine-only outbound marker: set once a user message has been relayed to
     * the provider so a slow agent reply never re-sends the same prompt on every
     * poll tick. Survives engine restart (reconcile re-queues on stale sessions). */
    relayedAt: text("relayed_at"),
    /** Provider message id used to dedupe streaming deltas: message.updated /
     * part.updated deltas for the same assistant message upsert (not insert) the
     * same agent_messages row so content is updated in place. */
    providerMessageId: text("provider_message_id"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("idx_agent_messages_session").on(t.sessionId),
    index("idx_agent_messages_provider").on(t.providerMessageId),
    check("ck_agent_messages_role", sql`role in ('user','agent','tool')`),
  ],
);

/* ------------------------------------------------------------------ */
/* approval_requests (Phase 2)                                         */
/* ------------------------------------------------------------------ */

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => executionSessions.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    houseId: text("house_id").references(() => houses.id, { onDelete: "set null" }),
    providerRequestId: text("provider_request_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    title: text("title").notNull(),
    message: text("message").notNull().default(""),
    options: text("options").notNull().default("[]"),
    response: text("response"),
    createdAt: text("created_at").notNull().default(now()),
    respondedAt: text("responded_at"),
    /** Engine-only outbound marker: set once the user's action (approved /
     * rejected / replied) has been relayed to the provider. Distinct from the
     * status column so the user's chosen status is never conflated with
     * "relayed" — history keeps the actual approved/rejected/replied state. */
    relayedAt: text("relayed_at"),
  },
  (t) => [
    uniqueIndex("idx_approvals_provider").on(t.providerRequestId),
    index("idx_approvals_session").on(t.sessionId),
    index("idx_approvals_status").on(t.status),
    index("idx_approvals_house").on(t.houseId),
    check("ck_approvals_kind", sql`kind in ('permission','question')`),
    check(
      "ck_approvals_status",
      sql`status in ('pending','approved','rejected','replied','cancelled')`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* artifacts (Phase 2)                                                 */
/* ------------------------------------------------------------------ */

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => executionSessions.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    kind: text("kind").notNull().default("other"),
    content: text("content").notNull().default(""),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("idx_artifacts_session").on(t.sessionId),
    index("idx_artifacts_task").on(t.taskId),
    check("ck_artifacts_kind", sql`kind in ('diff','file_list','result','other')`),
  ],
);

/* ------------------------------------------------------------------ */
/* notifications (Phase 2)                                            */
/* ------------------------------------------------------------------ */

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    houseId: text("house_id").references(() => houses.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    approvalRequestId: text("approval_request_id").references(() => approvalRequests.id, {
      onDelete: "cascade",
    }),
    read: integer("read", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("idx_notifications_read").on(t.read),
    index("idx_notifications_house").on(t.houseId),
    index("idx_notifications_created").on(t.createdAt),
    check(
      "ck_notifications_type",
      sql`type in ('approval','completion','failure','system')`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* usage_records (Phase 2)                                             */
/* ------------------------------------------------------------------ */

export const usageRecords = sqliteTable(
  "usage_records",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => executionSessions.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    houseId: text("house_id").references(() => houses.id, { onDelete: "set null" }),
    modelId: text("model_id").notNull().default(""),
    provider: text("provider").notNull().default("opencode"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cost: real("cost").notNull().default(0),
    estimated: integer("estimated", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("idx_usage_records_session").on(t.sessionId),
    index("idx_usage_records_house").on(t.houseId),
    index("idx_usage_records_task").on(t.taskId),
  ],
);

/* ------------------------------------------------------------------ */
/* subtasks (Phase 4 — High Lord orchestration)                        */
/* ------------------------------------------------------------------ */
/*                                                                     */
/* Orchestrator-owned scheduling state, deliberately distinct from the  */
/* child task row's tasks.status (which the runner owns). Plan-local   */
/* ids are stored in `plan_id` ("s0","s1",...) so depends_on JSON edges */
/* stay renderable after delegation. The unique task_id index makes    */
/* the subtask↔child-task link 1:1, enforcing max delegation depth 1.  */
/* ------------------------------------------------------------------ */

export const subtasks = sqliteTable(
  "subtasks",
  {
    id: text("id").primaryKey(),
    parentTaskId: text("parent_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }), // the child task row (null until delegation)
    orderIndex: integer("order_index").notNull(), // plan order (0..n-1)
    dependsOn: text("depends_on").notNull().default("[]"), // JSON: [plan-local ids] (plan-graph edges)
    status: text("status").notNull().default("planned"), // orchestrator-owned lifecycle
    attemptCount: integer("attempt_count").notNull().default(0), // repeated-failure rule
    planId: text("plan_id").notNull(), // plan-local identity ("s0","s1",...) assigned by the planner
    title: text("title").notNull(),
    instructions: text("instructions").notNull().default(""),
    completionRequirements: text("completion_requirements").notNull().default(""),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [
    uniqueIndex("idx_subtasks_task").on(t.taskId), // 1:1 child task ↔ subtask row
    index("idx_subtasks_parent").on(t.parentTaskId),
    uniqueIndex("idx_subtasks_parent_plan").on(t.parentTaskId, t.planId),
    check(
      "ck_subtasks_status",
      sql`status in ('planned','ready','delegated','in_flight','completed','failed','cancelled')`,
    ),
    check("ck_subtasks_order", sql`order_index >= 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* handoffs (Phase 4 — High Lord orchestration)                        */
/* ------------------------------------------------------------------ */
/*                                                                     */
/* One row per subtask, created at delegation time. Keyed by house ids  */
/* (MVP: 1 house = 1 agent). source_house_id is normally the High Lord, */
/* destination_house_id the executor. destination is nullable on delete */
/* so history survives a house being archived+deleted.                 */
/* ------------------------------------------------------------------ */

export const handoffs = sqliteTable(
  "handoffs",
  {
    id: text("id").primaryKey(),
    parentTaskId: text("parent_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    subtaskId: text("subtask_id")
      .notNull()
      .references(() => subtasks.id, { onDelete: "cascade" }),
    sourceHouseId: text("source_house_id").references(() => houses.id, {
      onDelete: "set null",
    }), // High Lord
    destinationHouseId: text("destination_house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "set null" }), // executor
    instructions: text("instructions").notNull().default(""),
    context: text("context").notNull().default("{}"), // JSON
    artifacts: text("artifacts").notNull().default("[]"), // JSON: expected artifact refs
    completionRequirements: text("completion_requirements").notNull().default(""),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("idx_handoffs_subtask").on(t.subtaskId),
    index("idx_handoffs_parent").on(t.parentTaskId),
  ],
);

/* ---------------------------------------------------------------- */
/* Export row types                                                 */
/* ---------------------------------------------------------------- */

export type HouseRow = typeof houses.$inferSelect;
export type HouseNew = typeof houses.$inferInsert;

export type AgentRow = typeof agents.$inferSelect;
export type AgentNew = typeof agents.$inferInsert;

export type AgentConfigurationRow = typeof agentConfigurations.$inferSelect;
export type AgentConfigurationNew = typeof agentConfigurations.$inferInsert;

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectNew = typeof projects.$inferInsert;

export type ProviderConfigRow = typeof providerConfigs.$inferSelect;
export type ProviderConfigNew = typeof providerConfigs.$inferInsert;

export type TaskRow = typeof tasks.$inferSelect;
export type TaskNew = typeof tasks.$inferInsert;

export type EngineStateRow = typeof engineState.$inferSelect;

export type ExecutionSessionRow = typeof executionSessions.$inferSelect;
export type ExecutionSessionNew = typeof executionSessions.$inferInsert;

export type ExecutionEventRow = typeof executionEvents.$inferSelect;
export type ExecutionEventNew = typeof executionEvents.$inferInsert;

export type AgentMessageRow = typeof agentMessages.$inferSelect;
export type AgentMessageNew = typeof agentMessages.$inferInsert;

export type ApprovalRequestRow = typeof approvalRequests.$inferSelect;
export type ApprovalRequestNew = typeof approvalRequests.$inferInsert;

export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactNew = typeof artifacts.$inferInsert;

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationNew = typeof notifications.$inferInsert;

export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type UsageRecordNew = typeof usageRecords.$inferInsert;

export type SubtaskRow = typeof subtasks.$inferSelect;
export type SubtaskNew = typeof subtasks.$inferInsert;

export type HandoffRow = typeof handoffs.$inferSelect;
export type HandoffNew = typeof handoffs.$inferInsert;
