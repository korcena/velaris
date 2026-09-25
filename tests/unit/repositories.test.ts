/**
 * Unit tests — repository CRUD against a temp SQLite file, per
 * IMPLEMENTATION_PLAN §5.6:
 *   - house create with nested agent+config, update
 *   - project duplicate-directory rejection (+ git info auto-detect)
 *   - provider-config seed idempotency + one-default-per-type
 *   - task insert/list/update
 *
 * Each test gets a fresh DB: migrate into a temp dir, run, teardown.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import {
  createHouse,
  updateHouse,
  transitionHouseStatus,
  deleteHouse,
  getHouse,
  listHouses,
  HouseNotFoundError,
  InvalidStatusTransitionError,
  HouseNotArchivedError,
} from "@/server/repositories/house-repo";
import type { HouseConfiguration } from "@/shared/types";
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  ProjectDirectoryExistsError,
  ProjectHasTasksError,
  ProjectDirectoryInvalidError,
} from "@/server/repositories/project-repo";
import {
  seedDefaultProviderConfigs,
  createProviderConfig,
  updateProviderConfig,
  deleteProviderConfig,
  listProviderConfigs,
  getProviderConfig,
  ProviderConfigNotFoundError,
} from "@/server/repositories/provider-config-repo";
import {
  createTask,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
  TaskNotFoundError,
  InvalidTaskStatusTransitionError,
} from "@/server/repositories/task-repo";
import {
  createExecutionSession,
  getExecutionSession,
  createAgentMessage,
  upsertAgentMessage,
  listAgentMessagesForSession,
} from "@/server/repositories/execution-repo";
import { agentMessages, agents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-repo-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Shared fixtures                                                     */
/* ------------------------------------------------------------------ */

const houseConfiguration: HouseConfiguration = {
  systemPrompt: "You are Azriel.",
  executionProvider: "opencode",
  aiProvider: "ollama-cloud",
  modelId: "glm-5.3",
  workspaceAllowlist: ["/home/kate/development/personal-projects/velaris"],
  tools: ["fs", "shell", "git"],
  permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
  approvalPolicy: "always",
  concurrency: 2,
};

const houseInput = {
  name: "House of Shadows",
  description: "Quiet, precise engineering work after dark",
  agent: { name: "Azriel", role: "Shadow-singer · senior engineer" },
  configuration: houseConfiguration,
};

/* ================================================================== */
/* houses                                                              */
/* ================================================================== */

describe("house repository", () => {
  it("creates a house with nested agent + configuration in one tx", () => {
    const db = getDb();
    const house = createHouse(db, houseInput);

    expect(house.id).toBeTruthy();
    expect(house.name).toBe("House of Shadows");
    expect(house.status).toBe("active");
    expect(house.agent).toEqual({ name: "Azriel", role: "Shadow-singer · senior engineer" });
    expect(house.configuration.systemPrompt).toBe("You are Azriel.");
    expect(house.configuration.executionProvider).toBe("opencode");
    expect(house.configuration.modelId).toBe("glm-5.3");
    expect(house.configuration.workspaceAllowlist).toEqual([
      "/home/kate/development/personal-projects/velaris",
    ]);
    expect(house.configuration.tools).toEqual(["fs", "shell", "git"]);
    expect(house.configuration.permissions).toEqual({
      fileSystem: "ask",
      shell: "ask",
      network: "deny",
      git: "allow",
    });
    expect(house.configuration.approvalPolicy).toBe("always");
    expect(house.configuration.concurrency).toBe(2);

    // All three rows written atomically.
    const raw = getRawDb();
    const counts = raw
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM houses WHERE id = ?) AS h,
           (SELECT COUNT(*) FROM agents WHERE house_id = ?) AS a,
           (SELECT COUNT(*) FROM agent_configurations) AS c`,
      )
      .get(house.id, house.id) as { h: number; a: number; c: number };
    expect(counts).toEqual({ h: 1, a: 1, c: 1 });
  });

  it("getHouse returns the embedded agent + configuration", () => {
    const db = getDb();
    const house = createHouse(db, houseInput);
    const fetched = getHouse(db, house.id);
    expect(fetched?.agent.name).toBe("Azriel");
    expect(fetched?.configuration.concurrency).toBe(2);
  });

  it("getHouse returns null for an unknown id", () => {
    expect(getHouse(getDb(), randomUUID())).toBeNull();
  });

  it("updates scalar fields and nested agent/config patches independently", () => {
    const db = getDb();
    const house = createHouse(db, houseInput);

    const updated = updateHouse(db, house.id, {
      name: "House of Mist",
      agent: { role: "Night-tracker" },
      configuration: { modelId: "new-model", concurrency: 4 },
    });

    expect(updated.name).toBe("House of Mist");
    // Untouched nested keys are preserved.
    expect(updated.agent.name).toBe("Azriel"); // agent.name untouched
    expect(updated.agent.role).toBe("Night-tracker");
    expect(updated.configuration.modelId).toBe("new-model");
    expect(updated.configuration.concurrency).toBe(4);
    expect(updated.configuration.systemPrompt).toBe("You are Azriel."); // preserved
    expect(updated.configuration.tools).toEqual(["fs", "shell", "git"]); // preserved
  });

  it("updateHouse throws HouseNotFoundError for unknown id", () => {
    expect(() => updateHouse(getDb(), randomUUID(), { name: "X" })).toThrow(
      HouseNotFoundError,
    );
  });

  it("listHouses excludes archived by default; includeArchived shows them", () => {
    const db = getDb();
    const a = createHouse(db, { ...houseInput, name: "A" });
    const b = createHouse(db, { ...houseInput, name: "B" });
    transitionHouseStatus(db, b.id, "archived");

    const visible = listHouses(db, {});
    const all = listHouses(db, { includeArchived: true });
    expect(visible.map((h) => h.id)).toEqual([a.id]);
    expect(all.map((h) => h.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("transitionHouseStatus enforces the rule set (422-grade errors)", () => {
    const db = getDb();
    const house = createHouse(db, houseInput);

    expect(transitionHouseStatus(db, house.id, "disabled").status).toBe("disabled");
    expect(transitionHouseStatus(db, house.id, "active").status).toBe("active");
    expect(transitionHouseStatus(db, house.id, "archived").status).toBe("archived");
    // archived is terminal
    expect(() => transitionHouseStatus(db, house.id, "active")).toThrow(
      InvalidStatusTransitionError,
    );
  });

  it("deleteHouse cascades agent + configuration and only works when archived", () => {
    const db = getDb();
    const house = createHouse(db, houseInput);

    expect(() => deleteHouse(db, house.id)).toThrow(HouseNotArchivedError);

    transitionHouseStatus(db, house.id, "archived");
    deleteHouse(db, house.id);

    const raw = getRawDb();
    const counts = raw
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM houses) AS h,
           (SELECT COUNT(*) FROM agents) AS a,
           (SELECT COUNT(*) FROM agent_configurations) AS c`,
      )
      .get() as { h: number; a: number; c: number };
    expect(counts).toEqual({ h: 0, a: 0, c: 0 }); // cascade worked

    expect(() => deleteHouse(db, house.id)).toThrow(HouseNotFoundError);
  });

  it("honours an explicit id when supplied", () => {
    const db = getDb();
    const id = randomUUID();
    const house = createHouse(db, { ...houseInput, id });
    expect(house.id).toBe(id);
  });
});

/* ================================================================== */
/* projects                                                            */
/* ================================================================== */

describe("project repository", () => {
  let projDir: string;
  let gitDir: string;

  beforeEach(() => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-projdir-"));
    gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-gitdir-"));
    // Turn gitDir into a real git repo with a commit + remote for detection.
    execSync("git init -b main", { cwd: gitDir });
    execSync("git config user.email t@t.t && git config user.name T", { cwd: gitDir });
    fs.writeFileSync(path.join(gitDir, "a.txt"), "a");
    execSync("git add . && git commit -m init", { cwd: gitDir });
    execSync("git remote add origin http://example.com/repo.git", { cwd: gitDir });
  });

  afterEach(() => {
    fs.rmSync(projDir, { recursive: true, force: true });
    fs.rmSync(gitDir, { recursive: true, force: true });
  });

  it("creates a project, auto-detecting git info for a repo directory", () => {
    const db = getDb();
    const project = createProject(db, {
      name: "Velaris",
      description: "The city",
      directory: gitDir,
    });

    expect(project.directory).toBe(gitDir);
    expect(project.gitInfo.branch).toBe("main");
    expect(project.gitInfo.remote).toBe("http://example.com/repo.git");
    expect(project.gitInfo.dirty).toBe(false);
  });

  it("reports dirty state for an uncommitted change", () => {
    const db = getDb();
    fs.writeFileSync(path.join(gitDir, "b.txt"), "b");
    const project = createProject(db, { name: "Dirty", directory: gitDir });
    expect(project.gitInfo.dirty).toBe(true);
  });

  it("returns null git info for a non-repo directory", () => {
    const db = getDb();
    const project = createProject(db, { name: "Plain", directory: projDir });
    expect(project.gitInfo).toEqual({ branch: null, remote: null, dirty: false });
  });

  it("rejects a duplicate directory (unique constraint)", () => {
    const db = getDb();
    createProject(db, { name: "One", directory: projDir });
    expect(() => createProject(db, { name: "Two", directory: projDir })).toThrow(
      ProjectDirectoryExistsError,
    );
  });

  it("rejects a nonexistent directory", () => {
    expect(() =>
      createProject(getDb(), {
        name: "Ghost",
        directory: path.join(os.tmpdir(), `velaris-nonexistent-${Date.now()}`),
      }),
    ).toThrow(ProjectDirectoryInvalidError);
  });

  it("rejects a relative directory", () => {
    expect(() =>
      createProject(getDb(), { name: "Rel", directory: "relative/dir" }),
    ).toThrow(ProjectDirectoryInvalidError);
  });

  it("rejects a file path (not a directory)", () => {
    const file = path.join(projDir, "file.txt");
    fs.writeFileSync(file, "x");
    expect(() => createProject(getDb(), { name: "File", directory: file })).toThrow(
      ProjectDirectoryInvalidError,
    );
  });

  it("updates fields; directory change re-validates uniqueness and git info", () => {
    const db = getDb();
    const p1 = createProject(db, { name: "One", directory: projDir });
    createProject(db, { name: "Two", directory: gitDir });

    // Changing p1's directory to p2's must conflict.
    expect(() => updateProject(db, p1.id, { directory: gitDir })).toThrow(
      ProjectDirectoryExistsError,
    );

    // Plain field update leaves the directory + git info alone.
    const renamed = updateProject(db, p1.id, { name: "Renamed", description: "d" });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.directory).toBe(projDir);

    // A legal directory move re-validates existence and re-detects git info.
    const otherGit = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-gitdir2-"));
    try {
      execSync("git init -b trunk", { cwd: otherGit });
      execSync("git config user.email t@t.t && git config user.name T", { cwd: otherGit });
      fs.writeFileSync(path.join(otherGit, "c.txt"), "c");
      execSync("git add . && git commit -m init", { cwd: otherGit });
      const moved = updateProject(db, p1.id, { directory: otherGit });
      expect(moved.directory).toBe(otherGit);
      expect(moved.gitInfo.branch).toBe("trunk"); // re-detected after move
    } finally {
      fs.rmSync(otherGit, { recursive: true, force: true });
    }
  });

  it("lists and gets projects", () => {
    const db = getDb();
    const a = createProject(db, { name: "A", directory: projDir });
    const b = createProject(db, { name: "B", directory: gitDir });
    const listed = listProjects(db);
    expect(listed.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(getProject(db, a.id)?.name).toBe("A");
    expect(getProject(db, randomUUID())).toBeNull();
  });

  it("deleteProject blocked when tasks reference it; allowed otherwise", () => {
    const db = getDb();
    const project = createProject(db, { name: "P", directory: projDir });
    createTask(db, { title: "T", projectId: project.id });

    expect(() => deleteProject(db, project.id)).toThrow(ProjectHasTasksError);

    // Remove the referencing task, then deletion succeeds.
    const taskId = listTasks(db, { projectId: project.id })[0].id;
    deleteTask(db, taskId);
    expect(() => deleteProject(db, project.id)).not.toThrow();
  });

  it("treats a directory with shell metacharacters as a literal path (no command execution)", () => {
    const db = getDb();
    // A real directory whose NAME contains shell metacharacters. Before the
    // execFileSync fix this caused arbitrary command execution via
    // `git -C "${directory}" ...` string interpolation in a shell.
    const marker = path.join(tmpDir, "GIT_INJECT_MARKER");
    const evilName = `evil"; touch ${marker}; echo "`;
    const evilDir = path.join(tmpDir, evilName);
    // evilName contains slashes (the marker path), so the joined path nests —
    // recursive mkdir creates the intermediate literal-named directories.
    fs.mkdirSync(evilDir, { recursive: true });

    try {
      const project = createProject(db, { name: "Evil", directory: evilDir });
      // Registration succeeds (the directory genuinely exists)…
      expect(project.directory).toBe(evilDir);
      // …and the metacharacters had no shell effect — git simply reports
      // "not a repository" for the literal path.
      expect(project.gitInfo).toEqual({ branch: null, remote: null, dirty: false });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(evilDir, { recursive: true, force: true });
    }
  });
});

/* ================================================================== */
/* provider configs                                                    */
/* ================================================================== */

describe("provider config repository", () => {
  it("seeds the two defaults idempotently (call twice → same rows)", () => {
    const raw = getRawDb();
    const first = seedDefaultProviderConfigs(raw);
    expect(first).toBe(2);

    const rows = listProviderConfigs(getDb());
    expect(rows).toHaveLength(2);
    const opencode = rows.find((r) => r.type === "opencode");
    const ollama = rows.find((r) => r.type === "ollama");
    expect(opencode?.name).toBe("OpenCode (local)");
    expect(opencode?.baseUrl).toBe("http://127.0.0.1:4096");
    expect(opencode?.isDefault).toBe(true);
    expect(ollama?.name).toBe("Ollama (local)");
    expect(ollama?.baseUrl).toBe("http://localhost:11434");
    expect(ollama?.isDefault).toBe(true);

    // Second call inserts nothing.
    expect(seedDefaultProviderConfigs(raw)).toBe(0);
    expect(listProviderConfigs(getDb())).toHaveLength(2);
  });

  it("seed accepts BOTH the raw connection and the Drizzle wrapper (engine + web boot paths)", () => {
    // The engine boot calls seed with the raw connection; the web bootstrap
    // and any service-layer caller may hand over the Drizzle wrapper. Both
    // must work — the wrapper must be unwrapped via $client, not crash on
    // `prepare is not a function`.
    const viaRaw = seedDefaultProviderConfigs(getRawDb());
    expect(viaRaw).toBe(2);

    // Idempotent when called with the Drizzle wrapper on a seeded DB.
    expect(seedDefaultProviderConfigs(getDb())).toBe(0);
    expect(listProviderConfigs(getDb())).toHaveLength(2);
  });

  it("seed skips a type that already has a config (partial idempotency)", () => {
    const db = getDb();
    createProviderConfig(db, { name: "Custom OpenCode", type: "opencode", baseUrl: "http://x:1" });
    const raw = getRawDb();
    const inserted = seedDefaultProviderConfigs(raw);
    // ollama was absent → 1 insert; opencode already existed → skipped.
    expect(inserted).toBe(1);
    const opencodeRows = listProviderConfigs(db).filter((r) => r.type === "opencode");
    expect(opencodeRows).toHaveLength(1);
    expect(opencodeRows[0].name).toBe("Custom OpenCode");
  });

  it("enforces one default per type when a new config becomes default", () => {
    const db = getDb();
    seedDefaultProviderConfigs(getRawDb());
    const added = createProviderConfig(db, {
      name: "OpenCode (remote)",
      type: "opencode",
      baseUrl: "http://remote:4096",
      isDefault: true,
    });

    const rows = listProviderConfigs(db).filter((r) => r.type === "opencode");
    const defaults = rows.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(added.id);
  });

  it("updating isDefault=true demotes the previous default of that type", () => {
    const db = getDb();
    seedDefaultProviderConfigs(getRawDb());
    const added = createProviderConfig(db, {
      name: "OpenCode (remote)",
      type: "opencode",
      baseUrl: "http://remote:4096",
    });

    const updated = updateProviderConfig(db, added.id, { isDefault: true });
    expect(updated.isDefault).toBe(true);

    const defaults = listProviderConfigs(db).filter(
      (r) => r.type === "opencode" && r.isDefault,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(added.id);
  });

  it("changing default in the ollama type does not affect opencode defaults", () => {
    const db = getDb();
    seedDefaultProviderConfigs(getRawDb());
    const added = createProviderConfig(db, {
      name: "Ollama (remote)",
      type: "ollama",
      baseUrl: "http://remote:11434",
      isDefault: true,
    });

    const opencodeDefaults = listProviderConfigs(db).filter(
      (r) => r.type === "opencode" && r.isDefault,
    );
    expect(opencodeDefaults).toHaveLength(1);
    expect(opencodeDefaults[0].name).toBe("OpenCode (local)");
    const ollamaDefaults = listProviderConfigs(db).filter(
      (r) => r.type === "ollama" && r.isDefault,
    );
    expect(ollamaDefaults[0].id).toBe(added.id);
  });

  it("get / delete provider configs", () => {
    const db = getDb();
    const created = createProviderConfig(db, {
      name: "X",
      type: "opencode",
      baseUrl: "http://x:1",
    });
    expect(getProviderConfig(db, created.id)?.name).toBe("X");
    deleteProviderConfig(db, created.id);
    expect(getProviderConfig(db, created.id)).toBeNull();
    expect(() => deleteProviderConfig(db, created.id)).toThrow(ProviderConfigNotFoundError);
  });
});

/* ================================================================== */
/* tasks                                                               */
/* ================================================================== */

describe("task repository", () => {
  it("creates a task forced to status='queued' with defaults", () => {
    const db = getDb();
    const task = createTask(db, { title: "Fix the login bug" });

    expect(task.status).toBe("queued"); // Phase 1: locked at creation
    expect(task.type).toBe("general");
    expect(task.priority).toBe("medium");
    expect(task.description).toBe("");
    expect(task.houseId).toBeNull();
    expect(task.projectId).toBeNull();
    expect(task.workingDirectory).toBeNull();
    expect(task.executionPreferences).toEqual({});
    expect(task.attachments).toEqual([]);
  });

  it("accepts an extensible custom type", () => {
    const task = createTask(getDb(), { title: "T", type: "world_domination" });
    expect(task.type).toBe("world_domination");
  });

  it("lists with filters houseId/projectId/status", () => {
    const db = getDb();
    const h1 = createHouse(db, { ...houseInput, name: "H1" });
    const h2 = createHouse(db, { ...houseInput, name: "H2" });
    const t1 = createTask(db, { title: "T1", houseId: h1.id });
    const t2 = createTask(db, { title: "T2", houseId: h2.id });
    const t3 = createTask(db, { title: "T3", houseId: h1.id });

    expect(listTasks(db, { houseId: h1.id }).map((t) => t.id).sort()).toEqual(
      [t1.id, t3.id].sort(),
    );
    expect(listTasks(db, { houseId: h2.id })).toHaveLength(1);
    expect(listTasks(db, { status: "queued" })).toHaveLength(3);
    expect(listTasks(db, { status: "cancelled" })).toHaveLength(0);

    updateTask(db, t2.id, { status: "cancelled" });
    expect(listTasks(db, { status: "cancelled" }).map((t) => t.id)).toEqual([t2.id]);
    expect(listTasks(db, { status: "queued" }).map((t) => t.id).sort()).toEqual(
      [t1.id, t3.id].sort(),
    );
  });

  it("updates mutable fields", () => {
    const db = getDb();
    const task = createTask(db, { title: "Old title", priority: "low" });
    const updated = updateTask(db, task.id, {
      title: "New title",
      priority: "urgent",
      description: "with more detail",
      executionPreferences: { model: "glm-5.3", timeoutMinutes: 10 },
    });
    expect(updated.title).toBe("New title");
    expect(updated.priority).toBe("urgent");
    expect(updated.description).toBe("with more detail");
    expect(updated.executionPreferences).toEqual({
      model: "glm-5.3",
      timeoutMinutes: 10,
    });
  });

  it("cancels a queued task; queued→queued is a no-op; cancelled→queued is rejected (Phase 1 lock)", () => {
    const db = getDb();
    const task = createTask(db, { title: "T" });

    // Same-status "transition" queued→queued is an allowed no-op.
    expect(() => updateTask(db, task.id, { status: "queued" })).not.toThrow();

    expect(updateTask(db, task.id, { status: "cancelled" }).status).toBe("cancelled");

    // Once cancelled, re-queueing is an invalid transition in Phase 1.
    expect(() => updateTask(db, task.id, { status: "queued" })).toThrow(
      InvalidTaskStatusTransitionError,
    );
  });

  it("throws TaskNotFoundError for unknown ids", () => {
    expect(() => updateTask(getDb(), randomUUID(), { title: "x" })).toThrow(TaskNotFoundError);
    expect(() => deleteTask(getDb(), randomUUID())).toThrow(TaskNotFoundError);
    expect(getTask(getDb(), randomUUID())).toBeNull();
  });

  it("deleteTask removes the row", () => {
    const db = getDb();
    const task = createTask(db, { title: "T" });
    deleteTask(db, task.id);
    expect(getTask(db, task.id)).toBeNull();
  });
});

/* ================================================================== */
/* agent_messages — Phase 5 tool-loop columns                          */
/* ================================================================== */

describe("agent_messages tool-loop columns", () => {
  function seedSession(houseId?: string): { sessionId: string; houseId: string } {
    const h = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: { ...houseConfiguration, executionProvider: "opencode" },
    });
    const task = createTask(getDb(), { title: "T", houseId: h.id });
    const session = createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: houseId ?? h.id,
      provider: "opencode",
      modelId: "glm-5.3",
    });
    return { sessionId: session.id, houseId: h.id };
  }

  it("round-trips execution_sessions.agent_id (Phase 6 Stage B)", () => {
    const db = getDb();
    const house = createHouse(db, { ...houseInput, name: "Agent house" });
    const agent = db
      .select()
      .from(agents)
      .where(eq(agents.houseId, house.id))
      .get()!;
    const task = createTask(db, { title: "T", houseId: house.id });

    // Null by default — the pre-multi-agent shape.
    const nullSession = createExecutionSession(db, {
      taskId: task.id,
      houseId: house.id,
      provider: "opencode",
      modelId: "glm-5.3",
    });
    expect(nullSession.agentId).toBeNull();

    // Populated when a routed agent is supplied.
    const routed = createExecutionSession(db, {
      taskId: task.id,
      houseId: house.id,
      agentId: agent.id,
      provider: "opencode",
      modelId: "glm-5.3",
    });
    expect(routed.agentId).toBe(agent.id);
    // And it is persisted, not just echoed on the insert.
    const reread = getExecutionSession(db, routed.id);
    expect(reread?.agentId).toBe(agent.id);
  });

  it("round-trips a role='tool' message with toolCallId (upsertAgentMessage)", () => {
    const { sessionId } = seedSession();
    upsertAgentMessage(getDb(), {
      sessionId,
      role: "tool",
      content: "ok: wrote /work/a.txt",
      toolCallId: "call_1",
    });

    const msgs = listAgentMessagesForSession(getDb(), sessionId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("tool");
    expect(msgs[0].content).toBe("ok: wrote /work/a.txt");
  });

  it("round-trips an assistant message carrying tool_calls JSON", () => {
    const { sessionId } = seedSession();
    const toolCalls = JSON.stringify([
      { function: { name: "fs_read", arguments: { path: "/work/a.txt" } } },
    ]);
    createAgentMessage(getDb(), {
      sessionId,
      role: "agent",
      content: "I'll read that.",
      toolCalls,
    });
    const msgs = listAgentMessagesForSession(getDb(), sessionId);
    expect(msgs[0].role).toBe("agent");
    // The DTO surfaces role/content; toolCalls lives on the row (not DTO).
    const raw = getDb().select().from(agentMessages).all();
    expect(raw.find((r) => r.sessionId === sessionId)?.toolCalls).toBe(toolCalls);
  });

  it("rejects an unknown role via the CHECK constraint", () => {
    const { sessionId } = seedSession();
    expect(() =>
      createAgentMessage(getDb(), {
        sessionId,
        role: "system" as never,
        content: "nope",
      }),
    ).toThrow(/CHECK constraint failed|constraint failed/i);
  });
});