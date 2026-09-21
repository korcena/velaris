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
    check("ck_tasks_status", sql`status in ('queued','cancelled')`),
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
