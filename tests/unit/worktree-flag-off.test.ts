/**
 * Unit test — THE worktree regression guarantee (Phase 6.2 Stage S1.4).
 *
 * With `experimental.worktreeIsolation` OFF (the default), the queue path must
 * never touch the OpenCode `/experimental/worktree` endpoint. We prove this at
 * the HTTP boundary: the queue runs against a REAL `OpencodeClient` whose
 * `fetchImpl` records every URL, so no method-level mock can hide a call.
 *
 * The runner is mocked so this test isolates the queue's pre-run wiring (the
 * only place S1 added a client call).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { seedDefaultProviderConfigs } from "@/server/repositories/provider-config-repo";
import { createHouse } from "@/server/repositories/house-repo";
import { createTask } from "@/server/repositories/task-repo";
import type { AgentExecutionProvider } from "@/server/execution/types";
import { OpencodeClient } from "@/server/opencode";
import type { HouseConfiguration } from "@/shared/types";

vi.mock("@/server/execution/runner", () => ({
  executeTask: vi.fn(() => Promise.resolve({ sessionId: "sess", terminalStatus: "completed" })),
}));

import { TaskQueue } from "@/engine/queue";
import { executeTask } from "@/server/execution/runner";

let tmpDir: string;
let dbPath: string;

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

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-wt-off-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  // Seeded default OpenCode config has NO experimental flag → OFF.
  seedDefaultProviderConfigs(getDb());
  (executeTask as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("worktree flag OFF — no /experimental/worktree call (regression guarantee)", () => {
  it("never calls any /experimental/worktree endpoint from the queue path", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      // Only /api/health is expected on the flag-off path.
      return new Response(JSON.stringify({ healthy: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new OpencodeClient({ baseUrl: "http://oc:4096", fetchImpl });
    const createSpy = vi.spyOn(client, "createWorktree");
    const listSpy = vi.spyOn(client, "listWorktrees");
    const resetSpy = vi.spyOn(client, "resetWorktree");
    const deleteSpy = vi.spyOn(client, "deleteWorktree");

    const house = createHouse(getDb(), {
      name: "H",
      description: null,
      agent: { name: "A", role: "R" },
      configuration: makeConfig(),
    });
    createTask(getDb(), {
      title: "T",
      houseId: house.id,
      workingDirectory: tmpDir,
    });

    const queue = new TaskQueue({
      db: getDb(),
      raw: getRawDb(),
      adapter: {} as unknown as AgentExecutionProvider,
      client,
      log: vi.fn(),
    });

    await queue.start();
    await new Promise((r) => setTimeout(r, 80));
    await queue.stop();

    // The task was actually claimed + dispatched (so this is a meaningful pass).
    expect(executeTask).toHaveBeenCalledTimes(1);

    expect(createSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    expect(resetSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(urls.some((u) => u.includes("/experimental/worktree"))).toBe(false);
  });

  it("passes a null worktree context to the runner when the flag is OFF", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ healthy: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = new OpencodeClient({ baseUrl: "http://oc:4096", fetchImpl });

    const house = createHouse(getDb(), {
      name: "H2",
      description: null,
      agent: { name: "B", role: "R" },
      configuration: makeConfig(),
    });
    createTask(getDb(), { title: "T2", houseId: house.id, workingDirectory: tmpDir });

    const queue = new TaskQueue({
      db: getDb(),
      raw: getRawDb(),
      adapter: {} as unknown as AgentExecutionProvider,
      client,
      log: vi.fn(),
    });
    await queue.start();
    await new Promise((r) => setTimeout(r, 80));
    await queue.stop();

    const ctx = (executeTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      directory: string;
      worktreeDirectory: string | null;
      worktreeBranch: string | null;
    };
    expect(ctx.directory).toBe(tmpDir);
    expect(ctx.worktreeDirectory).toBeNull();
    expect(ctx.worktreeBranch).toBeNull();
  });
});
