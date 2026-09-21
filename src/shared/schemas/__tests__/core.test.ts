import { describe, it, expect } from "vitest";
import { canTransition, canDelete } from "@/server/repositories/house-repo";
import { houseCreateSchema, houseUpdateSchema } from "@/shared/schemas/house";
import { taskCreateSchema } from "@/shared/schemas/task";
import { projectCreateSchema } from "@/shared/schemas/project";

describe("house status transitions", () => {
  it("allows active <-> disabled", () => {
    expect(canTransition("active", "disabled")).toBe(true);
    expect(canTransition("disabled", "active")).toBe(true);
  });

  it("allows active|disabled -> archived", () => {
    expect(canTransition("active", "archived")).toBe(true);
    expect(canTransition("disabled", "archived")).toBe(true);
  });

  it("archived is terminal", () => {
    expect(canTransition("archived", "active")).toBe(false);
    expect(canTransition("archived", "disabled")).toBe(false);
    expect(canTransition("archived", "archived")).toBe(false);
  });

  it("DELETE only when archived", () => {
    expect(canDelete("archived")).toBe(true);
    expect(canDelete("active")).toBe(false);
    expect(canDelete("disabled")).toBe(false);
  });
});

describe("zod schemas — happy path & edges", () => {
  it("parses a fully-specified house create payload", () => {
    const input = {
      name: "House of Shadows",
      description: "quiet precision",
      agent: { name: "Azriel", role: "shadow-singer" },
      configuration: {
        systemPrompt: "You are Azriel.",
        executionProvider: "opencode",
        aiProvider: "ollama-cloud",
        modelId: "glm-5.3",
        workspaceAllowlist: ["/home/kate/velaris"],
        tools: ["fs", "shell"],
        permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
        approvalPolicy: "always",
        concurrency: 2,
      },
    };
    const out = houseCreateSchema.parse(input);
    expect(out.configuration.concurrency).toBe(2);
    expect(out.configuration.approvalPolicy).toBe("always");
  });

  it("rejects concurrency of 0", () => {
    const bad = {
      name: "X",
      agent: { name: "a", role: "r" },
      configuration: {
        systemPrompt: "p",
        executionProvider: "opencode",
        concurrency: 0,
      },
    };
    expect(() => houseCreateSchema.parse(bad)).toThrow(/≥ 1/i);
  });

  it("rejects trailing-whitespace-only required names", () => {
    expect(() =>
      houseCreateSchema.parse({
        name: "   ",
        agent: { name: "a", role: "r" },
        configuration: { systemPrompt: "p", executionProvider: "opencode" },
      }),
    ).toThrow();
  });

  it("task type is extensible (arbitrary non-empty string)", () => {
    const out = taskCreateSchema.parse({
      title: "Custom quest",
      type: "something_totally_new",
    });
    expect(out.type).toBe("something_totally_new");
  });

  it("project directory must be absolute", () => {
    expect(() =>
      projectCreateSchema.parse({ name: "P", directory: "relative/dir" }),
    ).toThrow(/absolute/);
  });
});
