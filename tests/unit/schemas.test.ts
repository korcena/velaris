/**
 * Unit tests — zod schemas (Phase 1), per IMPLEMENTATION_PLAN §5.6.
 *
 * Covers valid/invalid/edge cases for:
 *  - house create/update (nested agent + full configuration incl. the
 *    permissions object with allow/ask/deny, approvalPolicy, concurrency ≥ 1)
 *  - project (absolute directory, length limits)
 *  - provider-config (type enum, base URL http(s) requirement, one-default intent)
 *  - task (extensible type, priority enum, Phase-1 status locked queued/cancelled)
 */

import { describe, it, expect } from "vitest";
import {
  houseCreateSchema,
  houseUpdateSchema,
  houseStatusTransitionSchema,
  houseAgentCreateSchema,
  houseAgentUpdateSchema,
  permissionsSchema,
  permissionModeSchema,
} from "@/shared/schemas/house";
import { projectCreateSchema, projectUpdateSchema } from "@/shared/schemas/project";
import {
  providerConfigCreateSchema,
  providerConfigUpdateSchema,
} from "@/shared/schemas/provider-config";
import { taskCreateSchema, taskUpdateSchema } from "@/shared/schemas/task";
import { uuidSchema, trimmedNonEmpty, parseJson } from "@/shared/schemas/common";
import {
  planSchema,
  planSubtaskSchema,
  courtInstructionSchema,
  courtSteerSchema,
  planExecutionPreferencesSchema,
} from "@/shared/schemas/plan";
import {
  ORCHESTRATION_DEFAULTS, TASK_STATUSES, SESSION_STATUSES, AGENT_MESSAGE_ROLES,
  AUDIT_ACTORS, AUDIT_ENTITY_TYPES } from "@/shared/constants";
import {
  auditLogQuerySchema,
  AUDIT_LOG_DEFAULT_LIMIT,
  AUDIT_LOG_MAX_LIMIT,
} from "@/shared/schemas/audit";
import {
  templateCreateSchema,
  templateUpdateSchema,
  templateListQuerySchema,
  templateInstantiateSchema,
} from "@/shared/schemas/template";
import {
  archiveQuerySchema,
  ARCHIVE_DEFAULT_LIMIT,
  ARCHIVE_MAX_LIMIT,
  ARCHIVE_STATUSES,
} from "@/shared/schemas/archive";
import {
  usageQuerySchema,
  USAGE_BUCKETS,
  USAGE_DEFAULT_BUCKET,
  USAGE_DEFAULT_TASK_LIMIT,
  USAGE_MAX_TASK_LIMIT,
} from "@/shared/schemas/usage";
import { TEMPLATE_KINDS, DEFAULT_TEMPLATES } from "@/shared/constants";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const validPermissions = {
  fileSystem: "ask",
  shell: "ask",
  network: "deny",
  git: "allow",
};

const validHouseCreate = {
  name: "House of Shadows",
  description: "Quiet, precise engineering work after dark",
  agent: { name: "Azriel", role: "Shadow-singer · senior engineer" },
  configuration: {
    systemPrompt: "You are Azriel.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: ["/home/kate/development/personal-projects/velaris"],
    tools: ["fs", "shell", "git"],
    permissions: validPermissions,
    approvalPolicy: "always",
    concurrency: 1,
  },
};

const minimalHouseCreate = {
  name: "House of Mists",
  agent: { name: "Rhysand", role: "High Lord" },
  configuration: {
    systemPrompt: "You are Rhysand.",
    executionProvider: "opencode",
    permissions: {
      fileSystem: "ask",
      shell: "ask",
      network: "deny",
      git: "allow",
    },
  },
};

/* ------------------------------------------------------------------ */
/* House — create                                                      */
/* ------------------------------------------------------------------ */

describe("houseCreateSchema", () => {
  it("parses the full spec payload from IMPLEMENTATION_PLAN §5.4", () => {
    const out = houseCreateSchema.parse(validHouseCreate);
    expect(out.name).toBe("House of Shadows");
    expect(out.agent.name).toBe("Azriel");
    expect(out.configuration.executionProvider).toBe("opencode");
    expect(out.configuration.aiProvider).toBe("ollama-cloud");
    expect(out.configuration.modelId).toBe("glm-5.3");
    expect(out.configuration.workspaceAllowlist).toEqual([
      "/home/kate/development/personal-projects/velaris",
    ]);
    expect(out.configuration.tools).toEqual(["fs", "shell", "git"]);
    expect(out.configuration.permissions).toEqual(validPermissions);
    expect(out.configuration.approvalPolicy).toBe("always");
    expect(out.configuration.concurrency).toBe(1);
  });

  it("applies documented defaults for omitted optional fields", () => {
    const out = houseCreateSchema.parse(minimalHouseCreate);
    expect(out.description).toBe("");
    expect(out.configuration.aiProvider).toBe("ollama-cloud");
    expect(out.configuration.modelId).toBe("");
    expect(out.configuration.workspaceAllowlist).toEqual([]);
    expect(out.configuration.tools).toEqual([]);
    expect(out.configuration.approvalPolicy).toBe("always");
    expect(out.configuration.concurrency).toBe(1);
  });

  it("rejects a missing name", () => {
    const { name, ...rest } = validHouseCreate;
    expect(() => houseCreateSchema.parse(rest)).toThrow();
  });

  it("rejects a whitespace-only name", () => {
    expect(() =>
      houseCreateSchema.parse({ ...minimalHouseCreate, name: "   " }),
    ).toThrow(/empty/);
  });

  it("rejects names over 80 characters", () => {
    expect(() =>
      houseCreateSchema.parse({ ...minimalHouseCreate, name: "x".repeat(81) }),
    ).toThrow(/at most 80/);
  });

  it("rejects a missing agent", () => {
    const { agent, ...rest } = validHouseCreate;
    expect(() => houseCreateSchema.parse(rest)).toThrow();
  });

  it("rejects an agent with an empty role", () => {
    expect(() =>
      houseCreateSchema.parse({
        ...minimalHouseCreate,
        agent: { name: "Azriel", role: "" },
      }),
    ).toThrow();
  });

  it("rejects a missing configuration", () => {
    const { configuration, ...rest } = validHouseCreate;
    expect(() => houseCreateSchema.parse(rest)).toThrow();
  });

  it("rejects an unknown executionProvider", () => {
    expect(() =>
      houseCreateSchema.parse({
        ...minimalHouseCreate,
        configuration: {
          ...minimalHouseCreate.configuration,
          executionProvider: "skynet",
        },
      }),
    ).toThrow();
  });

  it("rejects concurrency below 1", () => {
    expect(() =>
      houseCreateSchema.parse({
        ...minimalHouseCreate,
        configuration: { ...minimalHouseCreate.configuration, concurrency: 0 },
      }),
    ).toThrow(/≥ 1/);
  });

  it("rejects a non-integer concurrency", () => {
    expect(() =>
      houseCreateSchema.parse({
        ...minimalHouseCreate,
        configuration: { ...minimalHouseCreate.configuration, concurrency: 1.5 },
      }),
    ).toThrow();
  });

  it("accepts large (multi-quest) concurrency", () => {
    const out = houseCreateSchema.parse({
      ...minimalHouseCreate,
      configuration: { ...minimalHouseCreate.configuration, concurrency: 8 },
    });
    expect(out.configuration.concurrency).toBe(8);
  });

  it("rejects an unknown approval policy", () => {
    expect(() =>
      houseCreateSchema.parse({
        ...minimalHouseCreate,
        configuration: {
          ...minimalHouseCreate.configuration,
          approvalPolicy: "sometimes",
        },
      }),
    ).toThrow();
  });

  it("accepts every documented approval policy", () => {
    for (const policy of ["never", "always", "risky_only"] as const) {
      const out = houseCreateSchema.parse({
        ...minimalHouseCreate,
        configuration: { ...minimalHouseCreate.configuration, approvalPolicy: policy },
      });
      expect(out.configuration.approvalPolicy).toBe(policy);
    }
  });

  it("rejects a permissions object with an unknown mode", () => {
    expect(() =>
      houseCreateSchema.parse({
        ...minimalHouseCreate,
        configuration: {
          ...minimalHouseCreate.configuration,
          permissions: { ...validPermissions, network: "grant" },
        },
      }),
    ).toThrow();
  });

  it("rejects a missing permissions object entirely", () => {
    const {
      configuration: { permissions, ...configRest },
      ...houseRest
    } = validHouseCreate as typeof validHouseCreate & {
      configuration: Record<string, unknown>;
    };
    expect(() =>
      houseCreateSchema.parse({
        ...houseRest,
        configuration: configRest,
      }),
    ).toThrow();
  });

  it("defaults an omitted permission key to its documented default (per-key defaults)", () => {
    // The schema gives each permission action its own default (fileSystem ask,
    // shell ask, network deny, git allow) — omitting one applies the default
    // rather than failing validation.
    const out = houseCreateSchema.parse({
      ...minimalHouseCreate,
      configuration: {
        ...minimalHouseCreate.configuration,
        permissions: {
          fileSystem: "ask",
          shell: "ask",
          network: "deny",
          // git omitted -> defaults to "allow"
        },
      },
    });
    expect(out.configuration.permissions.git).toBe("allow");
  });

  it("rejects a whitespace-only system prompt", () => {
    expect(() =>
      houseCreateSchema.parse({
        ...minimalHouseCreate,
        configuration: {
          ...minimalHouseCreate.configuration,
          systemPrompt: "   ",
        },
      }),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* House — update                                                      */
/* ------------------------------------------------------------------ */

describe("houseUpdateSchema", () => {
  it("accepts an empty patch (no-op update)", () => {
    const out = houseUpdateSchema.parse({});
    expect(out).toEqual({});
  });

  it("accepts a name-only patch", () => {
    const out = houseUpdateSchema.parse({ name: "Renamed" });
    expect(out.name).toBe("Renamed");
    expect(out.description).toBeUndefined();
  });

  it("accepts a partially-specified nested agent (ARCHITECTURE §7)", () => {
    const out = houseUpdateSchema.parse({ agent: { name: "Cassian" } });
    expect(out.agent).toEqual({ name: "Cassian" });
  });

  it("accepts a partially-specified nested configuration", () => {
    const out = houseUpdateSchema.parse({
      configuration: { modelId: "llama-3" },
    });
    expect(out.configuration).toEqual({ modelId: "llama-3" });
  });

  it("does not apply defaults to absent fields (absent ≠ wiped)", () => {
    const out = houseUpdateSchema.parse({ name: "Only Name" });
    expect(out.description).toBeUndefined();
    expect(out.agent).toBeUndefined();
    expect(out.configuration).toBeUndefined();
  });

  it("still validates provided fields on update", () => {
    expect(() => houseUpdateSchema.parse({ name: "" })).toThrow();
    expect(() =>
      houseUpdateSchema.parse({
        configuration: { concurrency: 0 },
      }),
    ).toThrow(/≥ 1/);
  });
});

/* ------------------------------------------------------------------ */
/* House — status transition payload                                   */
/* ------------------------------------------------------------------ */

describe("houseStatusTransitionSchema", () => {
  it("accepts each valid status", () => {
    for (const status of ["active", "disabled", "archived"] as const) {
      expect(houseStatusTransitionSchema.parse({ status }).status).toBe(status);
    }
  });

  it("rejects an unknown status", () => {
    expect(() => houseStatusTransitionSchema.parse({ status: "paused" })).toThrow();
  });

  it("rejects a missing status", () => {
    expect(() => houseStatusTransitionSchema.parse({})).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* House agents — Phase 6 Stage B                                      */
/* ------------------------------------------------------------------ */

describe("houseAgentCreateSchema / houseAgentUpdateSchema", () => {
  const valid = {
    name: "Cassian",
    role: "General · commander",
    configuration: {
      systemPrompt: "You are Cassian.",
      executionProvider: "opencode" as const,
      aiProvider: "ollama-cloud",
      modelId: "glm-5.3",
      workspaceAllowlist: ["/tmp"],
      tools: ["fs"],
      permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
      approvalPolicy: "always" as const,
      concurrency: 1,
    },
  };

  it("parses a valid create payload", () => {
    const out = houseAgentCreateSchema.parse(valid);
    expect(out.name).toBe("Cassian");
    expect(out.role).toBe("General · commander");
    expect(out.configuration.modelId).toBe("glm-5.3");
  });

  it("rejects a missing name/role", () => {
    expect(() => houseAgentCreateSchema.parse({ configuration: valid.configuration })).toThrow();
    expect(() => houseAgentCreateSchema.parse({ name: "X", configuration: valid.configuration })).toThrow();
  });

  it("rejects smuggled top-level keys (strict) such as houseId", () => {
    expect(() =>
      houseAgentCreateSchema.parse({
        ...valid,
        houseId: "11111111-1111-1111-1111-111111111111",
      }),
    ).toThrow();
  });

  it("update schema is partial and strict", () => {
    expect(houseAgentUpdateSchema.parse({}).name).toBeUndefined();
    expect(houseAgentUpdateSchema.parse({ role: "Commander" }).role).toBe("Commander");
    expect(houseAgentUpdateSchema.parse({ configuration: { modelId: "m2" } }).configuration).toEqual({
      modelId: "m2",
    });
    expect(() => houseAgentUpdateSchema.parse({ bogus: true })).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Permissions schema                                                   */
/* ------------------------------------------------------------------ */

describe("permissionsSchema / permissionModeSchema", () => {
  it("accepts all three modes for every key and defaults each", () => {
    const out = permissionsSchema.parse({
      fileSystem: "allow",
      shell: "ask",
      network: "ask",
      git: "deny",
    });
    expect(out).toEqual({
      fileSystem: "allow",
      shell: "ask",
      network: "ask",
      git: "deny",
    });
  });

  it("applies per-key defaults when keys are omitted", () => {
    const out = permissionsSchema.parse({});
    expect(out.fileSystem).toBe("ask");
    expect(out.shell).toBe("ask");
    expect(out.network).toBe("deny");
    expect(out.git).toBe("allow");
  });

  it("rejects invalid modes", () => {
    expect(() => permissionModeSchema.parse("maybe")).toThrow();
    expect(() => permissionsSchema.parse({ shell: "sometimes" })).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Project                                                              */
/* ------------------------------------------------------------------ */

describe("projectCreateSchema", () => {
  const valid = { name: "Velaris", directory: "/home/kate/velaris" };

  it("parses a valid project and defaults optional fields", () => {
    const out = projectCreateSchema.parse(valid);
    expect(out.name).toBe("Velaris");
    expect(out.directory).toBe("/home/kate/velaris");
    expect(out.description).toBe("");
    expect(out.defaultModel).toBeNull();
    expect(out.instructions).toBeNull();
  });

  it("rejects a relative directory", () => {
    expect(() => projectCreateSchema.parse({ ...valid, directory: "relative/dir" })).toThrow(
      /absolute/,
    );
  });

  it("rejects an empty directory", () => {
    expect(() => projectCreateSchema.parse({ ...valid, directory: "" })).toThrow();
  });

  it("rejects a missing name", () => {
    expect(() => projectCreateSchema.parse({ directory: "/tmp" })).toThrow();
  });

  it("rejects a name over 120 characters", () => {
    expect(() => projectCreateSchema.parse({ ...valid, name: "y".repeat(121) })).toThrow();
  });

  it("update schema is fully optional (empty patch OK)", () => {
    expect(projectUpdateSchema.parse({})).toEqual({});
    const out = projectUpdateSchema.parse({ name: "Renamed" });
    expect(out.name).toBe("Renamed");
    expect(out.directory).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Provider config                                                      */
/* ------------------------------------------------------------------ */

describe("providerConfigCreateSchema", () => {
  const valid = { name: "OpenCode (local)", type: "opencode", baseUrl: "http://127.0.0.1:4096" };

  it("parses a valid config and defaults isDefault/extra", () => {
    const out = providerConfigCreateSchema.parse(valid);
    expect(out.type).toBe("opencode");
    expect(out.isDefault).toBe(false);
    expect(out.extra).toEqual({});
  });

  it("accepts ollama type", () => {
    const out = providerConfigCreateSchema.parse({
      name: "Ollama (local)",
      type: "ollama",
      baseUrl: "http://localhost:11434",
    });
    expect(out.type).toBe("ollama");
  });

  it("rejects an unknown type", () => {
    expect(() =>
      providerConfigCreateSchema.parse({ ...valid, type: "anthropic" }),
    ).toThrow();
  });

  it("rejects a base URL without http(s) scheme", () => {
    expect(() => providerConfigCreateSchema.parse({ ...valid, baseUrl: "127.0.0.1:4096" })).toThrow(
      /http/,
    );
    expect(() => providerConfigCreateSchema.parse({ ...valid, baseUrl: "ftp://x" })).toThrow(/http/);
  });

  it("rejects a missing name", () => {
    expect(() =>
      providerConfigCreateSchema.parse({ type: "opencode", baseUrl: "http://x" }),
    ).toThrow();
  });

  it("update schema is fully optional", () => {
    expect(providerConfigUpdateSchema.parse({})).toEqual({});
    const out = providerConfigUpdateSchema.parse({ baseUrl: "http://elsewhere:4096" });
    expect(out.baseUrl).toBe("http://elsewhere:4096");
    expect(out.isDefault).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Task                                                                 */
/* ------------------------------------------------------------------ */

describe("taskCreateSchema", () => {
  it("parses a minimal task with all defaults", () => {
    const out = taskCreateSchema.parse({ title: "Fix the login bug" });
    expect(out.title).toBe("Fix the login bug");
    expect(out.description).toBe("");
    expect(out.type).toBe("general");
    expect(out.priority).toBe("medium");
    expect(out.houseId).toBeNull();
    expect(out.projectId).toBeNull();
    expect(out.agentId).toBeNull();
    expect(out.workingDirectory).toBeNull();
    expect(out.executionPreferences).toEqual({});
  });

  it("accepts an optional UUID agentId and rejects a non-uuid", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    expect(taskCreateSchema.parse({ title: "T", agentId: uuid }).agentId).toBe(uuid);
    expect(() => taskCreateSchema.parse({ title: "T", agentId: "not-a-uuid" })).toThrow(/UUID/);
  });

  it("accepts an arbitrary extensible type (not a closed enum)", () => {
    const out = taskCreateSchema.parse({ title: "T", type: "something_totally_new" });
    expect(out.type).toBe("something_totally_new");
  });

  it("accepts every documented priority", () => {
    for (const priority of ["low", "medium", "high", "urgent"] as const) {
      const out = taskCreateSchema.parse({ title: "T", priority });
      expect(out.priority).toBe(priority);
    }
  });

  it("rejects an unknown priority", () => {
    expect(() => taskCreateSchema.parse({ title: "T", priority: "critical" })).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => taskCreateSchema.parse({ title: "" })).toThrow();
  });

  it("rejects a title over 200 characters", () => {
    expect(() => taskCreateSchema.parse({ title: "t".repeat(201) })).toThrow(/at most 200/);
  });

  it("rejects a non-uuid houseId", () => {
    expect(() => taskCreateSchema.parse({ title: "T", houseId: "not-a-uuid" })).toThrow(/UUID/);
  });

  it("rejects a non-uuid projectId", () => {
    expect(() => taskCreateSchema.parse({ title: "T", projectId: "nope" })).toThrow(/UUID/);
  });

  it("has no status field on create (server forces 'queued')", () => {
    // status is intentionally absent from taskCreateSchema — it must not be
    // settable at creation. Assert the parsed type has no status key.
    const out = taskCreateSchema.parse({ title: "T" }) as Record<string, unknown>;
    expect("status" in out).toBe(false);
  });
});

describe("taskUpdateSchema", () => {
  it("accepts an empty patch", () => {
    expect(taskUpdateSchema.parse({})).toEqual({});
  });

  it("accepts cancellation (Phase 1's only allowed status change)", () => {
    const out = taskUpdateSchema.parse({ status: "cancelled" });
    expect(out.status).toBe("cancelled");
  });

  it("accepts re-affirming 'queued'", () => {
    const out = taskUpdateSchema.parse({ status: "queued" });
    expect(out.status).toBe("queued");
  });

  it("rejects statuses beyond the Phase 1 enum", () => {
    for (const status of ["running", "completed", "failed", "planning"]) {
      expect(() => taskUpdateSchema.parse({ status })).toThrow();
    }
  });
});

/* ------------------------------------------------------------------ */
/* High Lord plan & court schemas (Phase 4)                            */
/* ------------------------------------------------------------------ */

/** A valid, minimal plan the planner might emit for unit coverage. */
const validPlan = {
  subtasks: [
    {
      id: "s0",
      title: "Research the wards",
      description: "Map the outer wall defences",
      dependsOn: [],
      instructions: "Investigate the gates.",
    },
    {
      id: "s1",
      title: "Forge the keys",
      dependsOn: ["s0"],
      houseHints: "smithy, metalwork",
      artifacts: ["keys.md"],
    },
  ],
};

describe("planSchema / planSubtaskSchema", () => {
  it("parses a valid multi-subtask plan with dependencies", () => {
    const out = planSchema.parse(validPlan);
    expect(out.subtasks).toHaveLength(2);
    expect(out.subtasks[0].id).toBe("s0");
    expect(out.subtasks[0].description).toBe("Map the outer wall defences");
    expect(out.subtasks[1].dependsOn).toEqual(["s0"]);
    // applied defaults
    expect(out.subtasks[0].context).toEqual({});
    expect(out.subtasks[0].artifacts).toEqual([]);
    expect(out.subtasks[0].completionRequirements).toBe("");
    expect(out.subtasks[0].instructions).toBe("Investigate the gates.");
  });

  it("rejects an empty subtasks array (min 1)", () => {
    expect(() => planSchema.parse({ subtasks: [] })).toThrow(/at least one/);
  });

  it("rejects over-cap subtasks (ORCHESTRATION_DEFAULTS.MAX_SUBTASKS)", () => {
    const tooMany = Array.from({ length: ORCHESTRATION_DEFAULTS.MAX_SUBTASKS + 1 }, (_, i) => ({
      id: `s${i}`,
      title: `Task ${i}`,
    }));
    expect(() => planSchema.parse({ subtasks: tooMany })).toThrow(/at most 8/);
  });

  it("accepts exactly MAX_SUBTASKS", () => {
    const max = Array.from({ length: ORCHESTRATION_DEFAULTS.MAX_SUBTASKS }, (_, i) => ({
      id: `s${i}`,
      title: `Task ${i}`,
    }));
    expect(planSchema.parse({ subtasks: max }).subtasks).toHaveLength(max.length);
  });

  it("rejects a dependency referencing a non-min-1 plan id", () => {
    expect(() =>
      planSubtaskSchema.parse({ id: "s0", title: "x", dependsOn: [""] }),
    ).toThrow();
  });

  it("rejects a whitespace-only title / missing id", () => {
    expect(() => planSubtaskSchema.parse({ id: "", title: "x" })).toThrow();
    expect(() => planSubtaskSchema.parse({ id: "s0", title: "   " })).toThrow();
  });

  it("rejects a non-uuid explicit houseId", () => {
    expect(() =>
      planSubtaskSchema.parse({ id: "s0", title: "x", houseId: "not-a-uuid" }),
    ).toThrow(/UUID/);
  });

  it("accepts a null explicit houseId (fall back to hints)", () => {
    const out = planSubtaskSchema.parse({ id: "s0", title: "x", houseId: null });
    expect(out.houseId).toBeNull();
  });
});

describe("courtInstructionSchema", () => {
  it("parses a minimal instruction with defaults", () => {
    const out = courtInstructionSchema.parse({ instruction: "Build me a wall" });
    expect(out.instruction).toBe("Build me a wall");
    // Optional/nullable fields are absent, not coerced, when omitted.
    expect(out.projectId).toBeUndefined();
    expect(out.workingDirectory).toBeUndefined();
    expect(out.priority).toBeUndefined();
  });

  it("rejects an empty / whitespace-only instruction", () => {
    expect(() => courtInstructionSchema.parse({ instruction: "" })).toThrow();
    expect(() => courtInstructionSchema.parse({ instruction: "   " })).toThrow(/empty/);
  });

  it("rejects an unknown priority", () => {
    expect(() =>
      courtInstructionSchema.parse({ instruction: "x", priority: "critical" }),
    ).toThrow();
  });

  it("rejects non-uuid projectId", () => {
    expect(() =>
      courtInstructionSchema.parse({ instruction: "x", projectId: "nope" }),
    ).toThrow(/UUID/);
  });
});

describe("courtSteerSchema", () => {
  const good = "0b8d6e7f-3a2b-4c5d-9e8f-1a2b3c4d5e6f";

  it("parses a valid steer", () => {
    const out = courtSteerSchema.parse({ parentTaskId: good, message: "Also add tests" });
    expect(out.parentTaskId).toBe(good);
    expect(out.message).toBe("Also add tests");
  });

  it("rejects a missing message / non-uuid parentTaskId", () => {
    expect(() => courtSteerSchema.parse({ parentTaskId: good })).toThrow();
    expect(() => courtSteerSchema.parse({ parentTaskId: "nope", message: "x" })).toThrow(/UUID/);
  });
});

describe("planExecutionPreferencesSchema", () => {
  it("is partial / permissive (internal engine write shape, documented only)", () => {
    const empty = planExecutionPreferencesSchema.parse({});
    expect(empty).toEqual({});
    const full = planExecutionPreferencesSchema.parse({
      abortReason: "retries_exhausted",
      abortedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(full.abortReason).toBe("retries_exhausted");
    const partial = planExecutionPreferencesSchema.parse({ abortReason: "user_cancel" });
    expect(partial.abortedAt).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* common helpers                                                       */
/* ------------------------------------------------------------------ */

describe("common schema helpers", () => {
  it("uuidSchema accepts a v4 uuid and rejects junk", () => {
    const good = "0b8d6e7f-3a2b-4c5d-9e8f-1a2b3c4d5e6f";
    expect(uuidSchema.parse(good)).toBe(good);
    expect(() => uuidSchema.parse("1234")).toThrow();
  });

  it("trimmedNonEmpty rejects whitespace-only strings", () => {
    expect(trimmedNonEmpty(10).parse("  x  ")).toBe("x");
    expect(() => trimmedNonEmpty(10).parse("   ")).toThrow(/empty/);
    expect(() => trimmedNonEmpty(2).parse("abc")).toThrow(/at most 2/);
  });

  it("parseJson falls back on null/invalid JSON", () => {
    expect(parseJson("[]", [1])).toEqual([]);
    expect(parseJson(null, [])).toEqual([]);
    expect(parseJson("not json", [1])).toEqual([1]);
  });
});

/* ================================================================== */
/* Phase 5 status/role parity (decision Q3/Q4)                         */
/* ================================================================== */

describe("Phase 5 status/role parity", () => {
  it("TASK_STATUSES includes 'paused'", () => {
    expect(TASK_STATUSES).toContain("paused");
    expect(TASK_STATUSES).toContain("running");
  });

  it("SESSION_STATUSES includes 'paused'", () => {
    expect(SESSION_STATUSES).toContain("paused");
    expect(SESSION_STATUSES).toContain("running");
  });

  it("AGENT_MESSAGE_ROLES includes 'tool'", () => {
    expect([...AGENT_MESSAGE_ROLES]).toEqual(["user", "agent", "tool"]);
  });
});

/* ================================================================== */
/* Phase 6 — audit constants + query schema (decision Q9)              */
/* ================================================================== */

describe("audit constants", () => {
  it("AUDIT_ACTORS mirrors the ck_audit_actor CHECK", () => {
    expect([...AUDIT_ACTORS]).toEqual(["user", "engine"]);
  });

  it("AUDIT_ENTITY_TYPES lists the known extensible entity set", () => {
    expect(AUDIT_ENTITY_TYPES).toContain("house");
    expect(AUDIT_ENTITY_TYPES).toContain("approval");
    expect(AUDIT_ENTITY_TYPES).toContain("provider_config");
    expect(AUDIT_ENTITY_TYPES).toContain("template");
  });

  it("AUDIT_ENTITY_TYPES omits 'task' (no task CRUD is audited; m5)", () => {
    // Q9 scoped audit to web user-action rows; task lifecycle lives in
    // execution_events, so a 'task' filter option could never return rows.
    expect(AUDIT_ENTITY_TYPES).not.toContain("task");
  });
});

describe("auditLogQuerySchema", () => {
  it("coerces numeric query params and defaults optional filters", () => {
    const out = auditLogQuerySchema.parse({});
    expect(out.limit).toBeUndefined();
    expect(out.offset).toBeUndefined();
    expect(out.actor).toBeUndefined();
    expect(AUDIT_LOG_DEFAULT_LIMIT).toBe(25);
    expect(AUDIT_LOG_MAX_LIMIT).toBe(100);
  });

  it("accepts valid filters and coerces limit/offset from strings", () => {
    const out = auditLogQuerySchema.parse({
      limit: "10",
      offset: "5",
      actor: "user",
      entityType: "house",
      entityId: "h1",
      action: "create",
    });
    expect(out).toEqual({
      limit: 10,
      offset: 5,
      actor: "user",
      entityType: "house",
      entityId: "h1",
      action: "create",
    });
  });

  it("rejects unknown actor/entityType and out-of-range limits", () => {
    expect(() => auditLogQuerySchema.parse({ actor: "robot" })).toThrow();
    expect(() => auditLogQuerySchema.parse({ entityType: "spaceship" })).toThrow();
    expect(() => auditLogQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => auditLogQuerySchema.parse({ limit: String(AUDIT_LOG_MAX_LIMIT + 1) })).toThrow();
    expect(() => auditLogQuerySchema.parse({ limit: "nope" })).toThrow();
  });
});

/* ================================================================== */
/* Phase 6 Stage C — template schemas                                  */
/* ================================================================== */

const validHouseTemplatePayload = {
  description: "A house template",
  agent: { name: "Templar", role: "Knight" },
  configuration: {
    systemPrompt: "You are a templar.",
    executionProvider: "opencode" as const,
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: ["/tmp"],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always" as const,
    concurrency: 1,
  },
};

const validProjectTemplatePayload = {
  description: "A repo template",
  defaultModel: "glm-5.3",
  instructions: "Read the conventions.",
};

describe("template schemas (Phase 6 Stage C)", () => {
  it("TEMPLATE_KINDS + DEFAULT_TEMPLATES have house/project parity", () => {
    expect([...TEMPLATE_KINDS]).toEqual(["house", "project"]);
    expect(DEFAULT_TEMPLATES.length).toBeGreaterThan(0);
    expect(DEFAULT_TEMPLATES.some((t) => t.kind === "house")).toBe(true);
    expect(DEFAULT_TEMPLATES.some((t) => t.kind === "project")).toBe(true);
  });

  it("parses a house template create (no name in payload) and a project one", () => {
    const house = templateCreateSchema.parse({
      kind: "house",
      name: "H",
      description: "d",
      payload: validHouseTemplatePayload,
    });
    expect(house.kind).toBe("house");
    if (house.kind === "house") {
      expect(house.payload.agent.name).toBe("Templar");
      // name is not part of the payload (instantiation-supplied).
      expect("name" in house.payload).toBe(false);
    }

    const project = templateCreateSchema.parse({
      kind: "project",
      name: "P",
      payload: validProjectTemplatePayload,
    });
    expect(project.kind).toBe("project");
    if (project.kind === "project") {
      expect(project.payload.defaultModel).toBe("glm-5.3");
    }
  });

  it("rejects a kind/payload mismatch and smuggled keys (.strict())", () => {
    expect(() =>
      templateCreateSchema.parse({
        kind: "house",
        name: "H",
        payload: validProjectTemplatePayload,
      }),
    ).toThrow();
    expect(() =>
      templateCreateSchema.parse({
        kind: "house",
        name: "H",
        payload: validHouseTemplatePayload,
        isSeeded: true,
      }),
    ).toThrow();
  });

  it("update schema is partial + strict; list query validates kind", () => {
    expect(templateUpdateSchema.parse({}).name).toBeUndefined();
    expect(templateUpdateSchema.parse({ name: "Renamed" }).name).toBe("Renamed");
    expect(() => templateUpdateSchema.parse({ bogus: 1 })).toThrow();
    expect(templateListQuerySchema.parse({ kind: "project" }).kind).toBe("project");
    expect(() => templateListQuerySchema.parse({ kind: "spaceship" })).toThrow();
  });

  it("instantiate schema accepts optional name/agentName/directory and rejects junk", () => {
    const out = templateInstantiateSchema.parse({
      name: "X",
      agentName: "Y",
      directory: "/tmp",
    });
    expect(out).toEqual({ name: "X", agentName: "Y", directory: "/tmp" });
    expect(templateInstantiateSchema.parse({})).toEqual({});
    expect(() => templateInstantiateSchema.parse({ bogus: true })).toThrow();
  });
});

/* ================================================================== */
/* Phase 6 Stage D — archive query schema                              */
/* ================================================================== */

describe("archiveQuerySchema (Phase 6 Stage D)", () => {
  it("coerces pagination and defaults to 25/100 constants", () => {
    const out = archiveQuerySchema.parse({});
    expect(out.limit).toBeUndefined();
    expect(out.offset).toBeUndefined();
    expect(ARCHIVE_DEFAULT_LIMIT).toBe(25);
    expect(ARCHIVE_MAX_LIMIT).toBe(100);
    expect([...ARCHIVE_STATUSES]).toEqual(["completed", "failed", "cancelled", "interrupted"]);
  });

  it("accepts valid filters and coerces numeric strings", () => {
    const out = archiveQuerySchema.parse({
      q: "needle",
      houseId: "h1",
      status: "completed",
      type: "research",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      limit: "10",
      offset: "5",
    });
    expect(out).toEqual({
      q: "needle",
      houseId: "h1",
      status: "completed",
      type: "research",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      limit: 10,
      offset: 5,
    });
  });

  it("rejects a non-terminal status and out-of-range limits", () => {
    expect(() => archiveQuerySchema.parse({ status: "running" })).toThrow();
    expect(() => archiveQuerySchema.parse({ status: "queued" })).toThrow();
    expect(() => archiveQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => archiveQuerySchema.parse({ limit: String(ARCHIVE_MAX_LIMIT + 1) })).toThrow();
    expect(() => archiveQuerySchema.parse({ offset: "-1" })).toThrow();
    expect(() => archiveQuerySchema.parse({ limit: "nope" })).toThrow();
  });
});
/* ------------------------------------------------------------------ */
/* usageQuerySchema (Phase 6 Stage E)                                  */
/* ------------------------------------------------------------------ */

describe("usageQuerySchema (Phase 6 Stage E)", () => {
  it("defaults: all filters optional, bucket/taskLimit unset (service applies them)", () => {
    const out = usageQuerySchema.parse({});
    expect(out.bucket).toBeUndefined();
    expect(out.taskLimit).toBeUndefined();
    expect(USAGE_DEFAULT_BUCKET).toBe("day");
    expect(USAGE_DEFAULT_TASK_LIMIT).toBe(10);
    expect(USAGE_MAX_TASK_LIMIT).toBe(50);
    expect([...USAGE_BUCKETS]).toEqual(["day", "hour"]);
  });

  it("accepts valid filters and coerces taskLimit", () => {
    const out = usageQuerySchema.parse({
      houseId: "h1",
      taskId: "t1",
      modelId: "glm-5.3",
      provider: "opencode",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      bucket: "hour",
      taskLimit: "25",
    });
    expect(out).toEqual({
      houseId: "h1",
      taskId: "t1",
      modelId: "glm-5.3",
      provider: "opencode",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      bucket: "hour",
      taskLimit: 25,
    });
  });

  it("rejects an invalid bucket and out-of-range taskLimit", () => {
    expect(() => usageQuerySchema.parse({ bucket: "week" })).toThrow();
    expect(() => usageQuerySchema.parse({ taskLimit: "0" })).toThrow();
    expect(() => usageQuerySchema.parse({ taskLimit: String(USAGE_MAX_TASK_LIMIT + 1) })).toThrow();
    expect(() => usageQuerySchema.parse({ taskLimit: "nope" })).toThrow();
    expect(() => usageQuerySchema.parse({ houseId: "" })).toThrow();
  });
});
