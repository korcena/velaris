/**
 * Adversarial — OpenCode regression (focus #1).
 *
 * OLD (pre-seam) queue.processOnce(): `if (!(await this.deps.client.health())) return;`
 * at the TOP — so when OpenCode was unhealthy, the ENTIRE pass was skipped,
 * INCLUDING the High Lord supervisor `tickActivePlans(...)`.
 *
 * Stage A NEW behavior: per-provider health probes run at the top, and Ollama
 * tasks may proceed even when only OpenCode is down (that is Stage A's point).
 *
 * REGRESSION RISK / DEFECT: after the seam, `tickActivePlans(...)` ran
 * UNCONDITIONALLY at the bottom of processOnce — so the High Lord court
 * (steering, delegation, budget, consolidation) executed every tick while
 * OpenCode was down, hitting the (down) server via awaitSteerReply →
 * client.getSession/listMessages instead of being gated.
 *
 * FIX: `tickActivePlans` is now gated on OpenCode health — when OpenCode is
 * unhealthy the supervisor pass is skipped entirely (pre-seam parity), while
 * per-task dispatch still lets Ollama tasks through. This file is the permanent
 * regression guard for that gating.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { createHouse } from "@/server/repositories/house-repo";
import { createTask, getTask } from "@/server/repositories/task-repo";
import type { AgentExecutionProvider } from "@/server/execution/types";
import type { HouseConfiguration } from "@/shared/types";

vi.mock("@/server/execution/runner", () => ({
  executeTask: vi.fn(() => Promise.resolve({ sessionId: "sess", terminalStatus: "completed" })),
}));
vi.mock("@/engine/orchestrator", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/engine/orchestrator")>();
  return { ...mod, tickActivePlans: vi.fn(async () => undefined) };
});

import { TaskQueue } from "@/engine/queue";
import { tickActivePlans } from "@/engine/orchestrator";

let tmpDir: string;
let dbPath: string;

function makeConfig(executionProvider: HouseConfiguration["executionProvider"]): HouseConfiguration {
  return {
    systemPrompt: "x", executionProvider, aiProvider: "ollama-cloud",
    modelId: "m", workspaceAllowlist: [tmpDir], tools: ["fs"],
    permissions: { fileSystem: "allow", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always", concurrency: 1,
  };
}
function fakeOcClient(healthy = true) {
  return {
    health: vi.fn(async () => healthy),
    getSession: vi.fn(async () => null),
    listMessages: vi.fn(async () => []),
    listPendingPermissions: vi.fn(async () => []),
    listPendingQuestions: vi.fn(async () => []),
  } as unknown as never;
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-oc-reg-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
});
afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runOnePass(queue: TaskQueue) {
  await queue.start();
  await new Promise((r) => setTimeout(r, 60));
  await queue.stop();
}

describe("OpenCode health-gate control flow (Stage A regression)", () => {
  it("OpenCode task stays queued while OpenCode unhealthy (preserved)", async () => {
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: makeConfig("opencode") });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    const queue = new TaskQueue({ db: getDb(), raw: getRawDb(), adapter: {} as unknown as AgentExecutionProvider, client: fakeOcClient(false), log: vi.fn() });
    await runOnePass(queue);
    expect(getTask(getDb(), task.id)?.status).toBe("queued");
  });

  it("tickActivePlans is NOT called while OpenCode is unhealthy (pre-seam guarantee restored, DEFECT FIXED)", async () => {
    (tickActivePlans as unknown as ReturnType<typeof vi.fn>).mockClear();
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: makeConfig("opencode") });
    createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    const queue = new TaskQueue({ db: getDb(), raw: getRawDb(), adapter: {} as unknown as AgentExecutionProvider, client: fakeOcClient(false), log: vi.fn() });
    await runOnePass(queue);
    // FIXED: the OpenCode-dependent supervisor must not run when OpenCode is down.
    expect(tickActivePlans).not.toHaveBeenCalled();
  });

  it("tickActivePlans IS called when OpenCode is healthy (supervisor advances plans)", async () => {
    (tickActivePlans as unknown as ReturnType<typeof vi.fn>).mockClear();
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: makeConfig("opencode") });
    createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    const queue = new TaskQueue({ db: getDb(), raw: getRawDb(), adapter: {} as unknown as AgentExecutionProvider, client: fakeOcClient(true), log: vi.fn() });
    await runOnePass(queue);
    expect(tickActivePlans).toHaveBeenCalled();
  });

  it("an OLLAMA task is still eligible when only OpenCode is unhealthy (Stage A point preserved)", async () => {
    (tickActivePlans as unknown as ReturnType<typeof vi.fn>).mockClear();
    const house = createHouse(getDb(), { name: "H", description: null, agent: { name: "A", role: "R" }, configuration: makeConfig("ollama") });
    const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
    // OpenCode client reports unhealthy — but this house is Ollama. With no
    // Ollama client configured the task must be surfaced as failed (eligible,
    // i.e. NOT left gated on OpenCode), and the OpenCode supervisor is skipped.
    const ollama = { health: vi.fn(async () => true) };
    const queue = new TaskQueue({
      db: getDb(), raw: getRawDb(), adapter: {} as unknown as AgentExecutionProvider,
      client: fakeOcClient(false), ollamaClient: ollama as unknown as never,
      log: vi.fn(),
    });
    await runOnePass(queue);
    // Ollama task proceeds (claims + runs; no Ollama runtime configured → the
    // queue marks it failed rather than leaving it queued on the OpenCode gate).
    expect(getTask(getDb(), task.id)?.status).not.toBe("queued");
    expect(tickActivePlans).not.toHaveBeenCalled();
  });
});
