/**
 * Unit tests — provider seam & capability flags (Phase 5 Stage A).
 *
 * Proves:
 *  - the OpenCode adapter exposes kind="opencode" / supportsNativePause=false;
 *  - the factory resolves the right provider kind per house and builds the
 *    OpenCode adapter;
 *  - the queue's health gate is per-task/per-provider: an OpenCode task stays
 *    queued when OpenCode is unhealthy, while an Ollama house task is allowed
 *    through when only OpenCode is down (and is NOT routed through executeTask).
 *
 * Uses a real temp DB + fake health clients; the runner is mocked so no real
 * engine/OpenCode work happens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse } from "@/server/repositories/house-repo";
import { createTask, getTask } from "@/server/repositories/task-repo";
import type { AgentExecutionProvider } from "@/server/execution/types";
import { createOpenCodeAdapter } from "@/server/execution/opencode/provider";
import { OpencodeClient } from "@/server/opencode";
import { OllamaClient } from "@/server/execution/ollama/client";
import type { HouseConfiguration } from "@/shared/types";
import {
  createProviderForHouse,
  providerHealth,
  resolveProviderKind,
} from "@/engine/provider-factory";

vi.mock("@/server/execution/runner", () => ({
  executeTask: vi.fn(() => Promise.resolve({ sessionId: "sess", terminalStatus: "completed" })),
}));

import { TaskQueue } from "@/engine/queue";
import { executeTask } from "@/server/execution/runner";

let tmpDir: string;
let dbPath: string;

function makeConfig(executionProvider: "opencode" | "ollama"): HouseConfiguration {
  return {
    systemPrompt: "You are an agent.",
    executionProvider,
    aiProvider: "ollama-cloud",
    modelId: "glm-5.3",
    workspaceAllowlist: [tmpDir],
    tools: ["fs"],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };
}

function fakeOcClient(healthy = true) {
  return {
    health: vi.fn(async () => healthy),
  } as unknown as OpencodeClient;
}

function fakeOllamaClient(healthy = true) {
  return {
    health: vi.fn(async () => healthy),
    // The Stage F runtime calls chat(); a client without a reachable Ollama server
    // fails the run → task goes failing (deterministic here).
    chat: vi.fn(async () => {
      throw new Error("no Ollama server in this test");
    }),
  } as unknown as OllamaClient;
}

let logMock: (m: string) => void;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-seam-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  logMock = vi.fn();
  (executeTask as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("capability flags", () => {
  it("OpenCode adapter exposes kind=opencode and supportsNativePause=false", () => {
    const adapter = createOpenCodeAdapter({ client: fakeOcClient(true), db: getDb() });
    expect(adapter.kind).toBe("opencode");
    expect(adapter.supportsNativePause).toBe(false);
  });

  it("resolveProviderKind reads the house's executionProvider", () => {
    const h1 = createHouse(getDb(), {
      name: "H1",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig("opencode"),
    });
    const h2 = createHouse(getDb(), {
      name: "H2",
      description: null,
      agent: { name: "B", role: "R" },
      configuration: makeConfig("ollama"),
    });
    expect(resolveProviderKind(({ configuration: makeConfig("opencode") } as never))).toBe("opencode");
    expect(resolveProviderKind(h1)).toBe("opencode");
    expect(resolveProviderKind(h2)).toBe("ollama");
  });

  it("createProviderForHouse builds the OpenCode adapter, and the Ollama adapter now wires (Stage F)", () => {
    const adapter = createProviderForHouse("opencode", { db: getDb(), client: fakeOcClient(true) });
    expect(adapter.kind).toBe("opencode");
    // Stage F wired the Ollama tool-loop adapter; it requires an OllamaClient.
    const ollama = createProviderForHouse("ollama", { db: getDb(), ollamaClient: fakeOllamaClient(true) });
    expect(ollama.kind).toBe("ollama");
    expect(ollama.supportsNativePause).toBe(true);
    // Building the Ollama adapter without a client is a hard error (no runtime).
    expect(() => createProviderForHouse("ollama", { db: getDb() })).toThrow();
  });

  it("providerHealth is per-provider and opencode uses the client", async () => {
    expect(await providerHealth("opencode", { client: fakeOcClient(true) })).toBe(true);
    expect(await providerHealth("opencode", { client: fakeOcClient(false) })).toBe(false);
    expect(await providerHealth("ollama", { ollamaClient: fakeOllamaClient(true) })).toBe(true);
    expect(await providerHealth("ollama", { ollamaClient: fakeOllamaClient(false) })).toBe(false);
  });
});

async function runOnePass(queue: TaskQueue) {
  await queue.start();
  await new Promise((r) => setTimeout(r, 60));
  await queue.stop();
}

describe("queue per-provider health gate", () => {
  it("regression: OpenCode task stays queued while OpenCode is unhealthy", async () => {
    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig("opencode"),
    });
    const task = createTask(getDb(), {
      title: "T",
      houseId: house.id,
      workingDirectory: tmpDir,
    });
    const queue = new TaskQueue({
      db: getDb(),
      raw: getRawDb(),
      adapter: {} as unknown as AgentExecutionProvider,
      client: fakeOcClient(false),
      log: logMock,
    });
    await runOnePass(queue);
    expect(getTask(getDb(), task.id)?.status).toBe("queued");
  });

  it("lets an Ollama house task through when only OpenCode is down", async () => {
    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig("ollama"),
    });
    const task = createTask(getDb(), {
      title: "T",
      houseId: house.id,
      workingDirectory: tmpDir,
    });
    const queue = new TaskQueue({
      db: getDb(),
      raw: getRawDb(),
      adapter: {} as unknown as AgentExecutionProvider,
      client: fakeOcClient(false), // OpenCode DOWN
      ollamaClient: fakeOllamaClient(true), // Ollama up
      log: logMock,
    });
    await runOnePass(queue);
    // Claimed past the OpenCode health gate and routed to the Ollama runtime
    // (NOT executeTask). The fake Ollama chat throws → run fails to `failed`.
    expect(executeTask).not.toHaveBeenCalled();
    expect(getTask(getDb(), task.id)?.status).toBe("failed");
  });

  it("keeps an Ollama house task queued while Ollama is unhealthy", async () => {
    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig("ollama"),
    });
    const task = createTask(getDb(), {
      title: "T",
      houseId: house.id,
      workingDirectory: tmpDir,
    });
    const queue = new TaskQueue({
      db: getDb(),
      raw: getRawDb(),
      adapter: {} as unknown as AgentExecutionProvider,
      client: fakeOcClient(true),
      ollamaClient: fakeOllamaClient(false),
      log: logMock,
    });
    await runOnePass(queue);
    expect(getTask(getDb(), task.id)?.status).toBe("queued");
  });
});
