/**
 * Unit tests — queue worktree wiring (Phase 6.2 Stage S1.4 / S1.5).
 *
 * Flag ON + OpenCode: the run directory is a FRESH created worktree directory
 * (never a reused prior worktree, Q3) bound to the task's source repo via the
 * `?directory=` query param, and the context carries
 * worktreeDirectory/worktreeBranch. Flag OFF: only the acknowledged
 * `getWorktreeIsolationEnabled` read is added; no worktree call/event/session
 * change. Worktree-create OR source-binding failure: falls back to the normal
 * dir, emits an `error` event and still runs the task. Flag ON + provider ollama:
 * NO worktree is ever created.
 *
 * The queue's `executeTask` is mocked for the routing tests; one test imports
 * the REAL runner to prove the worktree fields are persisted on the session row.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { seedDefaultProviderConfigs } from "@/server/repositories/provider-config-repo";
import { createHouse, getHouse } from "@/server/repositories/house-repo";
import { createTask, getTask } from "@/server/repositories/task-repo";
import { createExecutionSession, listEventsForTask } from "@/server/repositories/execution-repo";
import type { AgentExecutionProvider } from "@/server/execution/types";
import { OpencodeClient } from "@/server/opencode";
import { OllamaClient } from "@/server/execution/ollama/client";
import type { HouseConfiguration } from "@/shared/types";

vi.mock("@/server/execution/runner", () => ({
  executeTask: vi.fn(() => Promise.resolve({ sessionId: "sess", terminalStatus: "completed" })),
}));
vi.mock("@/server/execution/ollama/runtime", () => ({
  runOllamaTask: vi.fn(() => Promise.resolve({ sessionId: "osess", terminalStatus: "completed" })),
}));

import { TaskQueue } from "@/engine/queue";
import { executeTask } from "@/server/execution/runner";
import { runOllamaTask } from "@/server/execution/ollama/runtime";
import { resolveWorktree, uniqueWorktreeName } from "@/engine/worktree";

let tmpDir: string;
let dbPath: string;
let dataHome: string;
let wtRoot: string;
function makeConfig(): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "m",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

/** Turn the default OpenCode config's worktree flag ON. */
function enableWorktreeFlag(): void {
  getRawDb()
    .prepare(`UPDATE provider_configs SET extra = ? WHERE type = 'opencode' AND is_default = 1`)
    .run(JSON.stringify({ experimental: { worktreeIsolation: true } }));
}

/**
 * A worktree directory that exists under the (real) worktree root AND is
 * correctly bound to the source repo (`tmpDir`) via its `.git` file, so the
 * M1 source-repo binding check passes. Mirrors `git worktree add`.
 */
function makeWorktreeDir(name: string): string {
  const dir = path.join(wtRoot, "hash", name);
  fs.mkdirSync(dir, { recursive: true });
  bindWorktree(dir, tmpDir, name);
  return dir;
}

/** Write a linked-worktree `.git` file pointing at `<source>/.git/worktrees/<name>`. */
function bindWorktree(worktreeDir: string, sourceDir: string, name: string): void {
  const gitdir = path.join(sourceDir, ".git", "worktrees", name);
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${gitdir}\n`);
}

/** A worktree dir bound to a DIFFERENT source repo (source-binding failure). */
function makeMisboundWorktreeDir(name: string): string {
  const dir = path.join(wtRoot, "hash", name);
  fs.mkdirSync(dir, { recursive: true });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-other-repo-"));
  bindWorktree(dir, other, name);
  return dir;
}

/**
 * Real client whose fetch is routed: health → healthy; POST
 * /experimental/worktree → the given info (or a rejection to simulate failure).
 * Captures every request URL so the `?directory=` binding can be asserted.
 */
function clientForWorktree(
  info: { name: string; branch: string; directory: string } | Error,
  captured?: { urls: string[]; postUrls: string[]; bodies?: unknown[] },
): OpencodeClient {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured?.urls.push(url);
    if (url.includes("/api/health")) {
      return new Response(JSON.stringify({ healthy: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/experimental/worktree") && (init?.method ?? "GET") === "POST") {
      captured?.postUrls.push(url);
      captured?.bodies?.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      if (info instanceof Error) throw info;
      return new Response(JSON.stringify(info), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return new OpencodeClient({ baseUrl: "http://oc:4096", fetchImpl });
}

function makeQueue(client: OpencodeClient, ollamaClient?: OllamaClient) {
  return new TaskQueue({
    db: getDb(),
    raw: getRawDb(),
    adapter: {} as unknown as AgentExecutionProvider,
    client,
    ollamaClient,
    log: vi.fn(),
  });
}

async function runOnePass(queue: TaskQueue): Promise<void> {
  await queue.start();
  await new Promise((r) => setTimeout(r, 80));
  await queue.stop();
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-wt-q-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  // Worktree root lives OUTSIDE the house allowlist (tmpDir) so the S1.5
  // allowlist exception is genuinely exercised.
  dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-wt-xdg-"));
  wtRoot = path.join(dataHome, "opencode", "worktree");
  fs.mkdirSync(wtRoot, { recursive: true });
  process.env.XDG_DATA_HOME = dataHome;
  migrate();
  seedDefaultProviderConfigs(getDb());
  (executeTask as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  delete process.env.XDG_DATA_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

describe("queue worktree wiring — flag ON + OpenCode", () => {
  it("runs in the created worktree directory and passes branch/directory in the context", async () => {
    enableWorktreeFlag();
    const wtDir = makeWorktreeDir("task-1");
    const captured = { urls: [] as string[], postUrls: [] as string[] };
    const client = clientForWorktree(
      { name: "task-1", branch: "opencode/task-1", directory: wtDir },
      captured,
    );

    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });

    await runOnePass(makeQueue(client));

    expect(executeTask).toHaveBeenCalledTimes(1);
    const ctx = (executeTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      directory: string;
      worktreeDirectory: string | null;
      worktreeBranch: string | null;
    };
    expect(ctx.directory).toBe(wtDir);
    expect(ctx.worktreeDirectory).toBe(wtDir);
    expect(ctx.worktreeBranch).toBe("opencode/task-1");
    // M2: createWorktree was called WITH the task's source repo as ?directory=.
    expect(captured.postUrls).toHaveLength(1);
    expect(captured.postUrls[0]).toContain(
      `/experimental/worktree?directory=${encodeURIComponent(fs.realpathSync(tmpDir))}`,
    );
    // The task was still claimed/advanced by the (mocked) runner.
    expect(getTask(getDb(), task.id)?.status).toBe("running");
  });

  it("ALWAYS creates a fresh worktree even when a prior session stored one (Q3: no reuse)", async () => {
    enableWorktreeFlag();
    const priorDir = makeWorktreeDir("prior");
    const freshDir = makeWorktreeDir("fresh");
    // A prior session for the same task already stored a usable worktree dir.
    const house = createHouse(getDb(), {
      name: "H-reuse",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: house.id,
      provider: "opencode",
      modelId: "m",
      directory: priorDir,
      worktreeDirectory: priorDir,
      worktreeBranch: "opencode/prior",
    });
    // Terminal so per-house concurrency does not block the new run; the stored
    // worktree mapping is what the removed reuse path would have picked up.
    getRawDb()
      .prepare("UPDATE execution_sessions SET status = 'completed' WHERE worktree_directory = ?")
      .run(priorDir);

    const captured = { urls: [] as string[], postUrls: [] as string[] };
    const client = clientForWorktree(
      { name: "fresh", branch: "opencode/fresh", directory: freshDir },
      captured,
    );
    await runOnePass(makeQueue(client));

    // A fresh worktree was created and used — the prior dir was NOT reused.
    expect(captured.postUrls).toHaveLength(1);
    const ctx = (executeTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      directory: string;
      worktreeDirectory: string | null;
    };
    expect(ctx.directory).toBe(freshDir);
    expect(ctx.worktreeDirectory).toBe(freshDir);
  });

  it("persists worktree_directory/worktree_branch on the session row (real runner)", async () => {
    const wtDir = makeWorktreeDir("persist-1");
    // Import the REAL runner (this module mocks it for the routing tests).
    const real = await vi.importActual<typeof import("@/server/execution/runner")>(
      "@/server/execution/runner",
    );

    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    const fullTask = getTask(getDb(), task.id)!;
    const fullHouse = getHouse(getDb(), house.id)!;
    const raw = getRawDb();
    const db = getDb();

    // Fake OpenCode client + adapter sufficient for the runner to write the
    // session row and terminate on an already-aborted signal.
    const fc = {
      subscribeEvents: () => () => {},
      getSession: vi.fn(async () => ({
        id: "prov-1",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
        model: { id: "", providerID: "" },
        time: { created: 0, updated: 0 },
        title: "",
      })),
      abortSession: vi.fn(async () => {}),
    };
    const adapter = {
      startTask: vi.fn(async () => ({ providerSessionId: "prov-1" })),
      sendMessage: vi.fn(async () => {}),
      cancelTask: vi.fn(async () => {}),
      respondToApproval: vi.fn(async () => {}),
      getDiff: vi.fn(async () => []),
    };

    const ac = new AbortController();
    ac.abort(); // abort immediately → runner writes the session row then terminates
    await real.executeTask(
      {
        db,
        raw,
        adapter: adapter as never,
        client: fc as never,
        task: fullTask,
        house: fullHouse,
        directory: wtDir,
        modelId: "m",
        worktreeDirectory: wtDir,
        worktreeBranch: "opencode/persist-1",
      },
      { signal: ac.signal, pollMs: 10 },
    );

    const row = raw
      .prepare("SELECT worktree_directory, worktree_branch FROM execution_sessions ORDER BY created_at DESC LIMIT 1")
      .get() as { worktree_directory: string | null; worktree_branch: string | null } | undefined;
    expect(row?.worktree_directory).toBe(wtDir);
    expect(row?.worktree_branch).toBe("opencode/persist-1");
  });
});

describe("queue worktree wiring — flag OFF (byte-identical)", () => {
  it("runs in the normal resolved dir and passes null worktree fields", async () => {
    const client = clientForWorktree({
      name: "x",
      branch: "opencode/x",
      directory: makeWorktreeDir("unused"),
    });
    const createSpy = vi.spyOn(client, "createWorktree");

    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });

    await runOnePass(makeQueue(client));

    const ctx = (executeTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      directory: string;
      worktreeDirectory: string | null;
      worktreeBranch: string | null;
    };
    expect(ctx.directory).toBe(tmpDir);
    expect(ctx.worktreeDirectory).toBeNull();
    expect(ctx.worktreeBranch).toBeNull();
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("queue worktree wiring — create failure falls back", () => {
  it("falls back to the normal dir, emits an error event, and still runs the task", async () => {
    enableWorktreeFlag();
    const client = clientForWorktree(new Error("boom: create failed"));

    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });

    await runOnePass(makeQueue(client));

    const ctx = (executeTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      directory: string;
      worktreeDirectory: string | null;
    };
    expect(ctx.directory).toBe(tmpDir);
    expect(ctx.worktreeDirectory).toBeNull();

    // M6: neutral message (creation vs validation/binding both land here); the
    // `detail` carries the specifics.
    const event = listEventsForTask(getDb(), task.id).find(
      (e) =>
        e.type === "error" &&
        (e.payload as Record<string, unknown>).error === "worktree isolation unavailable",
    );
    expect(event).toBeDefined();
    expect((event!.payload as Record<string, unknown>).detail).toContain("boom: create failed");
    // The task still ran (mocked runner advanced it).
    expect(getTask(getDb(), task.id)?.status).toBe("running");
  });

  it("source-repo binding failure → falls back to the normal dir + error event, task still runs", async () => {
    enableWorktreeFlag();
    // The created worktree is bound to a DIFFERENT source repo: the M1 defensive
    // `.git` gitdir check must reject it even though createWorktree "succeeded".
    const misbound = makeMisboundWorktreeDir("wrong-repo");
    const client = clientForWorktree({
      name: "wrong-repo",
      branch: "opencode/wrong-repo",
      directory: misbound,
    });

    const house = createHouse(getDb(), {
      name: "H-bind",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });

    await runOnePass(makeQueue(client));

    const ctx = (executeTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      directory: string;
      worktreeDirectory: string | null;
    };
    expect(ctx.directory).toBe(tmpDir);
    expect(ctx.worktreeDirectory).toBeNull();

    const event = listEventsForTask(getDb(), task.id).find(
      (e) => e.type === "error" && (e.payload as Record<string, unknown>).error === "worktree isolation unavailable",
    );
    expect(event).toBeDefined();
    expect(String((event!.payload as Record<string, unknown>).detail)).toContain("not bound to source repo");
    expect(getTask(getDb(), task.id)?.status).toBe("running");
  });
});

describe("queue worktree wiring — flag ON + provider ollama", () => {
  it("NEVER creates a worktree for an Ollama house even when the flag is ON", async () => {
    enableWorktreeFlag();
    const captured = { urls: [] as string[], postUrls: [] as string[] };
    const client = clientForWorktree(
      { name: "nope", branch: "opencode/nope", directory: makeWorktreeDir("nope") },
      captured,
    );
    const createSpy = vi.spyOn(client, "createWorktree");
    const ollama = { health: vi.fn(async () => true) } as unknown as OllamaClient;

    const house = createHouse(getDb(), {
      name: "H-ollama",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: { ...makeConfig(), executionProvider: "ollama" },
    });
    createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });

    await runOnePass(makeQueue(client, ollama));

    // Ollama routes to runOllamaTask and never touches the worktree endpoint.
    expect(runOllamaTask).toHaveBeenCalledTimes(1);
    expect(executeTask).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(captured.postUrls).toHaveLength(0);
    expect(captured.urls.some((u) => u.includes("/experimental/worktree"))).toBe(false);
  });
});

describe("resolveWorktree — no reuse of a prior worktree (Q3)", () => {
  it("always calls createWorktree; a stored prior session mapping does not short-circuit", async () => {
    enableWorktreeFlag();
    const priorDir = makeWorktreeDir("prior-direct");
    const freshDir = makeWorktreeDir("fresh-direct");
    const house = createHouse(getDb(), {
      name: "H-direct",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    createExecutionSession(getDb(), {
      taskId: task.id,
      houseId: house.id,
      provider: "opencode",
      modelId: "m",
      directory: priorDir,
      worktreeDirectory: priorDir,
      worktreeBranch: "opencode/prior-direct",
    });

    const captured = { urls: [] as string[], postUrls: [] as string[] };
    const client = clientForWorktree(
      { name: "fresh-direct", branch: "opencode/fresh-direct", directory: freshDir },
      captured,
    );
    const resolved = await resolveWorktree({
      client,
      task: getTask(getDb(), task.id)!,
      sourceDirectory: tmpDir,
      houseAllowlist: [tmpDir],
    });

    expect(captured.postUrls).toHaveLength(1);
    expect(resolved).toEqual({ directory: freshDir, branch: "opencode/fresh-direct" });
  });
});

describe("resolveWorktree — unique name per run (Q3 collision fix)", () => {
  it("names two consecutive runs of the SAME task differently (no collision)", async () => {
    enableWorktreeFlag();
    const firstDir = makeWorktreeDir("uniq-1");
    const secondDir = makeWorktreeDir("uniq-2");
    const house = createHouse(getDb(), {
      name: "H-uniq",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    const taskDto = getTask(getDb(), task.id)!;

    const first = { urls: [] as string[], postUrls: [] as string[], bodies: [] as unknown[] };
    const second = { urls: [] as string[], postUrls: [] as string[], bodies: [] as unknown[] };

    await resolveWorktree({
      client: clientForWorktree(
        { name: "uniq-1", branch: "opencode/uniq-1", directory: firstDir },
        first,
      ),
      task: taskDto,
      sourceDirectory: tmpDir,
      houseAllowlist: [tmpDir],
    });
    await resolveWorktree({
      client: clientForWorktree(
        { name: "uniq-2", branch: "opencode/uniq-2", directory: secondDir },
        second,
      ),
      task: taskDto,
      sourceDirectory: tmpDir,
      houseAllowlist: [tmpDir],
    });

    const firstName = (first.bodies[0] as { name: string }).name;
    const secondName = (second.bodies[0] as { name: string }).name;
    expect(firstName).not.toBe(secondName);
    // Both still start with the sanitized task id (debuggable per task).
    expect(firstName.startsWith(taskDto.id)).toBe(true);
    expect(secondName.startsWith(taskDto.id)).toBe(true);
  });

  it("keeps names path-safe and within the 60-char cap (long titles)", () => {
    const taskId = "12345678-1234-1234-1234-123456789012"; // 36 chars
    const longTitle = "Fix a very long and unwieldy title with punctuation! ".repeat(5);
    for (const input of [taskId, longTitle, "", "!!!", "UPPER_case/../escape"]) {
      const name = uniqueWorktreeName(input);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(60);
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
    // Same input yields different names (random suffix) but the same base cap.
    expect(uniqueWorktreeName(taskId, "aaaaaaaa")).not.toBe(
      uniqueWorktreeName(taskId, "bbbbbbbb"),
    );
    // A deterministic suffix keeps the whole slug within the cap even for a
    // max-length base: base is truncated to leave room for "-<suffix>".
    const name = uniqueWorktreeName("a".repeat(80), "deadbeef");
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith("-deadbeef")).toBe(true);
  });
});
