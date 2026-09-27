/**
 * Unit tests — worktree terminal cleanup + boot orphan sweep (Phase 6.2 Stage S1.4).
 *
 * Cleanup policy (Q3):
 *   - completed → deleteWorktree (clear the mapping on success)
 *   - failed/aborted/interrupted → resetWorktree (keep the mapping)
 *   - non-terminal → neither (the queue only cleans terminal results)
 *
 * Boot sweep:
 *   - deletes only unreferenced `opencode/*` worktrees under worktreeRoot()
 *   - respects the 1h grace period
 *   - never touches out-of-root paths or non-`opencode/*` branches
 *   - skips entirely when the flag is OFF
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
import { createExecutionSession } from "@/server/repositories/execution-repo";
import { cleanupWorktree, sweepWorktrees, WORKTREE_SWEEP_GRACE_MS } from "@/engine/worktree";
import { OpencodeClient } from "@/server/opencode";
import type { HouseConfiguration } from "@/shared/types";

vi.mock("@/server/execution/runner", () => ({
  executeTask: vi.fn(() => Promise.resolve({ sessionId: "sess", terminalStatus: "completed" })),
}));

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

function fakeClient() {
  return {
    deleteWorktree: vi.fn(async () => true),
    resetWorktree: vi.fn(async () => true),
    listWorktrees: vi.fn(async () => [] as string[]),
    health: vi.fn(async () => true),
    createWorktree: vi.fn(async () => ({ name: "", branch: "", directory: "" })),
  } as unknown as OpencodeClient & {
    deleteWorktree: ReturnType<typeof vi.fn>;
    resetWorktree: ReturnType<typeof vi.fn>;
    listWorktrees: ReturnType<typeof vi.fn>;
  };
}

function enableWorktreeFlag(): void {
  getRawDb()
    .prepare(`UPDATE provider_configs SET extra = ? WHERE type = 'opencode' AND is_default = 1`)
    .run(JSON.stringify({ experimental: { worktreeIsolation: true } }));
}

/** Create a real dir under the worktree root. */
function makeWorktreeDir(name: string, mtimeMs?: number): string {
  const dir = path.join(wtRoot, "hash", name);
  fs.mkdirSync(dir, { recursive: true });
  if (mtimeMs !== undefined) {
    const t = mtimeMs / 1000;
    fs.utimesSync(dir, t, t);
  }
  return dir;
}

function seedSession(worktreeDirectory: string | null, worktreeBranch: string | null) {
  const house = createHouse(getDb(), {
    name: `H-${Math.random().toString(36).slice(2, 7)}`,
    description: null,
    agent: { name: "A", role: "R" },
    configuration: makeConfig(),
  });
  const task = createTask(getDb(), { title: "T", houseId: house.id, workingDirectory: tmpDir });
  return createExecutionSession(getDb(), {
    taskId: task.id,
    houseId: house.id,
    provider: "opencode",
    modelId: "m",
    directory: tmpDir,
    worktreeDirectory,
    worktreeBranch,
  });
}

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-wt-clean-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  dataHome = path.join(tmpDir, "xdg");
  wtRoot = path.join(dataHome, "opencode", "worktree");
  fs.mkdirSync(wtRoot, { recursive: true });
  process.env.XDG_DATA_HOME = dataHome;
  migrate();
  seedDefaultProviderConfigs(getDb());
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  delete process.env.XDG_DATA_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cleanupWorktree — terminal policy", () => {
  it("completed → deleteWorktree and clears the session mapping", async () => {
    const dir = makeWorktreeDir("done");
    const session = seedSession(dir, "opencode/done");
    const client = fakeClient();

    await cleanupWorktree({
      db: getDb(),
      client,
      sessionId: session.id,
      directory: dir,
      terminalStatus: "completed",
      log: vi.fn(),
    });

    expect(client.deleteWorktree).toHaveBeenCalledWith(dir);
    expect(client.resetWorktree).not.toHaveBeenCalled();
    const row = getRawDb()
      .prepare("SELECT worktree_directory, worktree_branch FROM execution_sessions WHERE id = ?")
      .get(session.id) as { worktree_directory: string | null; worktree_branch: string | null };
    expect(row.worktree_directory).toBeNull();
    expect(row.worktree_branch).toBeNull();
  });

  it("completed but delete fails → keeps the mapping for the boot sweep", async () => {
    const dir = makeWorktreeDir("done-fail");
    const session = seedSession(dir, "opencode/done-fail");
    const client = fakeClient();
    client.deleteWorktree.mockResolvedValueOnce(false);

    await cleanupWorktree({
      db: getDb(),
      client,
      sessionId: session.id,
      directory: dir,
      terminalStatus: "completed",
      log: vi.fn(),
    });

    const row = getRawDb()
      .prepare("SELECT worktree_directory FROM execution_sessions WHERE id = ?")
      .get(session.id) as { worktree_directory: string | null };
    expect(row.worktree_directory).toBe(dir);
  });

  it.each(["failed", "aborted", "interrupted"] as const)(
    "%s → resetWorktree and keeps the mapping",
    async (terminalStatus) => {
      const dir = makeWorktreeDir(`keep-${terminalStatus}`);
      const session = seedSession(dir, `opencode/keep-${terminalStatus}`);
      const client = fakeClient();

      await cleanupWorktree({
        db: getDb(),
        client,
        sessionId: session.id,
        directory: dir,
        terminalStatus,
        log: vi.fn(),
      });

      expect(client.resetWorktree).toHaveBeenCalledWith(dir);
      expect(client.deleteWorktree).not.toHaveBeenCalled();
      const row = getRawDb()
        .prepare("SELECT worktree_directory FROM execution_sessions WHERE id = ?")
        .get(session.id) as { worktree_directory: string | null };
      expect(row.worktree_directory).toBe(dir);
    },
  );

  it("does nothing when the session has no worktree directory", async () => {
    const client = fakeClient();
    await cleanupWorktree({
      db: getDb(),
      client,
      sessionId: "none",
      directory: null,
      terminalStatus: "completed",
      log: vi.fn(),
    });
    expect(client.deleteWorktree).not.toHaveBeenCalled();
    expect(client.resetWorktree).not.toHaveBeenCalled();
  });

  it("swallows a thrown cleanup error (never propagates)", async () => {
    const dir = makeWorktreeDir("throw");
    const session = seedSession(dir, "opencode/throw");
    const client = fakeClient();
    client.deleteWorktree.mockRejectedValueOnce(new Error("network down"));

    await expect(
      cleanupWorktree({
        db: getDb(),
        client,
        sessionId: session.id,
        directory: dir,
        terminalStatus: "completed",
        log: vi.fn(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("sweepWorktrees — boot orphan sweep", () => {
  const OLD = Date.now() - WORKTREE_SWEEP_GRACE_MS - 60_000;
  const FRESH = Date.now() - 60_000;

  it("skips entirely when the flag is OFF (no client calls)", async () => {
    const client = fakeClient();
    await sweepWorktrees(getDb(), client, vi.fn());
    expect(client.listWorktrees).not.toHaveBeenCalled();
  });

  it("removes an unreferenced opencode/* worktree older than the grace period", async () => {
    enableWorktreeFlag();
    const orphan = makeWorktreeDir("orphan", OLD);
    const client = fakeClient();
    client.listWorktrees.mockResolvedValue([orphan]);
    const log = vi.fn();

    await sweepWorktrees(getDb(), client, log, {
      now: () => Date.now(),
      branchOf: () => "opencode/orphan",
    });

    expect(client.resetWorktree).toHaveBeenCalledWith(orphan);
    expect(client.deleteWorktree).toHaveBeenCalledWith(orphan);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("orphan"));
  });

  it("does NOT remove a worktree younger than the grace period", async () => {
    enableWorktreeFlag();
    const young = makeWorktreeDir("young", FRESH);
    const client = fakeClient();
    client.listWorktrees.mockResolvedValue([young]);

    await sweepWorktrees(getDb(), client, vi.fn(), {
      now: () => Date.now(),
      branchOf: () => "opencode/young",
    });

    expect(client.deleteWorktree).not.toHaveBeenCalled();
    expect(client.resetWorktree).not.toHaveBeenCalled();
  });

  it("does NOT remove a worktree referenced by a non-terminal session", async () => {
    enableWorktreeFlag();
    const live = makeWorktreeDir("live", OLD);
    seedSession(live, "opencode/live"); // status = pending (non-terminal)
    const client = fakeClient();
    client.listWorktrees.mockResolvedValue([live]);

    await sweepWorktrees(getDb(), client, vi.fn(), {
      now: () => Date.now(),
      branchOf: () => "opencode/live",
    });

    expect(client.deleteWorktree).not.toHaveBeenCalled();
  });

  it("DOES remove a worktree whose only referencing session is terminal", async () => {
    enableWorktreeFlag();
    const done = makeWorktreeDir("done-ref", OLD);
    const session = seedSession(done, "opencode/done-ref");
    // Mark the session completed in the DB.
    getRawDb()
      .prepare("UPDATE execution_sessions SET status = 'completed' WHERE id = ?")
      .run(session.id);
    const client = fakeClient();
    client.listWorktrees.mockResolvedValue([done]);

    await sweepWorktrees(getDb(), client, vi.fn(), {
      now: () => Date.now(),
      branchOf: () => "opencode/done-ref",
    });

    expect(client.deleteWorktree).toHaveBeenCalledWith(done);
  });

  it("never touches a non-opencode/* branch", async () => {
    enableWorktreeFlag();
    const foreign = makeWorktreeDir("foreign", OLD);
    const client = fakeClient();
    client.listWorktrees.mockResolvedValue([foreign]);

    await sweepWorktrees(getDb(), client, vi.fn(), {
      now: () => Date.now(),
      branchOf: () => "main",
    });

    expect(client.deleteWorktree).not.toHaveBeenCalled();
    expect(client.resetWorktree).not.toHaveBeenCalled();
  });

  it("never touches a worktree outside worktreeRoot()", async () => {
    enableWorktreeFlag();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-outside-"));
    const client = fakeClient();
    client.listWorktrees.mockResolvedValue([outside]);

    await sweepWorktrees(getDb(), client, vi.fn(), {
      now: () => Date.now(),
      branchOf: () => "opencode/outside",
    });

    expect(client.deleteWorktree).not.toHaveBeenCalled();
    expect(client.resetWorktree).not.toHaveBeenCalled();
  });

  it("is idempotent: a repeated sweep makes no further changes once removed", async () => {
    enableWorktreeFlag();
    const orphan = makeWorktreeDir("idem", OLD);
    const client = fakeClient();
    // First sweep sees it; second sweep sees nothing (it was deleted).
    client.listWorktrees.mockResolvedValueOnce([orphan]).mockResolvedValueOnce([]);

    await sweepWorktrees(getDb(), client, vi.fn(), {
      now: () => Date.now(),
      branchOf: () => "opencode/idem",
    });
    await sweepWorktrees(getDb(), client, vi.fn(), {
      now: () => Date.now(),
      branchOf: () => "opencode/idem",
    });

    expect(client.deleteWorktree).toHaveBeenCalledTimes(1);
  });

  // M4: realpath both sides so a symlink/trailing-slash difference cannot treat
  // an in-flight worktree as unreferenced and sweep it.
  it("does NOT remove a live worktree referenced via a symlinked/trailing-slash path", async () => {
    enableWorktreeFlag();
    const live = makeWorktreeDir("live-symlink", OLD);
    // Reference the SAME real directory through a symlink with a trailing slash.
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-wt-link-"));
    const link = path.join(linkDir, "link");
    fs.symlinkSync(live, link);
    seedSession(`${link}/`, "opencode/live-symlink"); // status = pending
    const client = fakeClient();
    client.listWorktrees.mockResolvedValue([live]);

    await sweepWorktrees(getDb(), client, vi.fn(), {
      now: () => Date.now(),
      branchOf: () => "opencode/live-symlink",
    });

    expect(client.deleteWorktree).not.toHaveBeenCalled();
    expect(client.resetWorktree).not.toHaveBeenCalled();
    fs.rmSync(linkDir, { recursive: true, force: true });
  });

  // M3: the sweep must never throw / prevent boot, even if the client hangs or
  // rejects. It is wrapped; a failure is logged and swallowed.
  it("never throws when listWorktrees rejects (boot must continue)", async () => {
    enableWorktreeFlag();
    const client = fakeClient();
    client.listWorktrees.mockRejectedValue(new Error("server unreachable"));
    const log = vi.fn();

    await expect(sweepWorktrees(getDb(), client, log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("listWorktrees failed"));
  });

  it("bounds a hung listWorktrees call (clientTimeoutMs) instead of stalling boot", async () => {
    enableWorktreeFlag();
    const client = fakeClient();
    // Never resolves — simulates a hung server.
    client.listWorktrees.mockImplementation(() => new Promise<string[]>(() => {}));
    const log = vi.fn();

    await expect(
      sweepWorktrees(getDb(), client, log, { clientTimeoutMs: 30 }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("listWorktrees failed"));
  });
});
