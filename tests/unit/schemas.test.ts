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
    expect(out.workingDirectory).toBeNull();
    expect(out.executionPreferences).toEqual({});
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