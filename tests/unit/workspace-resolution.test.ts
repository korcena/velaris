/**
 * Unit tests — effective workspace resolution helper
 * (src/server/repositories/workspace.ts).
 *
 * The helper is the single rule every execution gate consumes:
 *  - non-empty house allowlist → that array verbatim (registry not consulted);
 *  - empty house allowlist     → the registered project directories;
 *  - zero projects + empty     → [] (nothing runs).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createProject } from "@/server/repositories/project-repo";
import { createTask } from "@/server/repositories/task-repo";
import {
  effectiveWorkspaceAllowlist,
  projectDirectoryForTask,
} from "@/server/repositories/workspace";
import type { HouseConfiguration } from "@/shared/types";

let tmpDir: string;
let projA: string;
let projB: string;

function makeConfig(allowlist: string[]): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: allowlist,
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "never",
    concurrency: 1,
  };
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-ws-res-"));
  projA = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-ws-a-"));
  projB = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-ws-b-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(projA, { recursive: true, force: true });
  fs.rmSync(projB, { recursive: true, force: true });
});

function register(dir: string, name: string) {
  return createProject(getDb(), {
    name,
    directory: dir,
    gitInfo: { branch: null, remote: null, dirty: false },
  });
}

describe("effectiveWorkspaceAllowlist", () => {
  it("non-empty config → the config array verbatim (registry not consulted)", () => {
    register(projA, "A");
    register(projB, "B");
    const config = makeConfig(["/some/explicit/path"]);
    expect(effectiveWorkspaceAllowlist(getDb(), config)).toEqual(["/some/explicit/path"]);
  });

  it("empty config → the registered project directories", () => {
    register(projA, "A");
    register(projB, "B");
    expect(effectiveWorkspaceAllowlist(getDb(), makeConfig([]))).toEqual([projA, projB]);
  });

  it("empty config + zero projects → []", () => {
    expect(effectiveWorkspaceAllowlist(getDb(), makeConfig([]))).toEqual([]);
  });
});

describe("projectDirectoryForTask", () => {
  it("returns the task's project directory", () => {
    const p = register(projA, "A");
    const task = createTask(getDb(), { title: "T", projectId: p.id });
    expect(projectDirectoryForTask(getDb(), task)).toBe(projA);
  });

  it("returns null when the task has no project", () => {
    const task = createTask(getDb(), { title: "T" });
    expect(projectDirectoryForTask(getDb(), task)).toBeNull();
  });

  it("returns null for a dangling project id", () => {
    // A task DTO whose project no longer exists (e.g. the task row's FK would
    // normally prevent this; the helper must still degrade to null).
    const task = createTask(getDb(), { title: "T" });
    const dangling = { ...task, projectId: "does-not-exist" };
    expect(projectDirectoryForTask(getDb(), dangling)).toBeNull();
  });
});
