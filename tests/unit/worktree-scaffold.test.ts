/**
 * Unit tests — worktree isolation flag (Phase 5 Stage I — Q7, default OFF).
 *
 * The flag `experimental.worktreeIsolation` defaults to false. While OFF (the
 * default, and the only state wired into the engine) NO code path invokes the
 * OpenCode `/experimental/worktree` endpoints, so normal execution is unchanged.
 * We prove:
 *  - the flag defaults to false and only an explicit `=== true` enables it;
 *  - the new OpenCode client worktree methods exist but are never auto-invoked
 *    on construction.
 *
 * Detailed request-shape coverage of the client worktree methods lives in
 * `worktree-client.test.ts`; the live round-trip is the opt-in `@real` test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import { seedDefaultProviderConfigs, getWorktreeIsolationEnabled } from "@/server/repositories/provider-config-repo";
import { OpencodeClient } from "@/server/opencode";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-worktree-"));
  dbPath = path.join(tmpDir, "test.db");
  process.env.VELARIS_DB_PATH = dbPath;
  migrate();
  seedDefaultProviderConfigs(getDb());
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getWorktreeIsolationEnabled (Stage I scaffold)", () => {
  it("defaults to false with the seeded default OpenCode config (flag absent)", () => {
    expect(getWorktreeIsolationEnabled(getDb())).toBe(false);
  });

  it("is true ONLY when extra.experimental.worktreeIsolation === true", () => {
    // OFF (default) is a no-op.
    expect(getWorktreeIsolationEnabled(getDb())).toBe(false);

    // Explicitly turn the scaffold flag ON on the default OpenCode config.
    getRawDb()
      .prepare(`UPDATE provider_configs SET extra = ? WHERE type = 'opencode' AND is_default = 1`)
      .run(JSON.stringify({ experimental: { worktreeIsolation: true } }));
    expect(getWorktreeIsolationEnabled(getDb())).toBe(true);

    // Toggle back off.
    getRawDb()
      .prepare(`UPDATE provider_configs SET extra = ? WHERE type = 'opencode' AND is_default = 1`)
      .run(JSON.stringify({}));
    expect(getWorktreeIsolationEnabled(getDb())).toBe(false);
  });

  it("survives malformed stored extra without throwing (returns false)", async () => {
    getRawDb()
      .prepare(`UPDATE provider_configs SET extra = ? WHERE type = 'opencode' AND is_default = 1`)
      .run("not json");
    expect(getWorktreeIsolationEnabled(getDb())).toBe(false);
  });
});

describe("OpencodeClient worktree methods — no live claim, flag off by default", () => {
  it("exposes the worktree methods but never auto-invokes them on construction", () => {
    let called = false;
    const fetchImpl = vi.fn(async () => {
      called = true;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    expect(typeof client.createWorktree).toBe("function");
    expect(typeof client.listWorktrees).toBe("function");
    expect(typeof client.resetWorktree).toBe("function");
    expect(typeof client.deleteWorktree).toBe("function");
    // Constructing the client never calls the endpoint (the flag-off path is a no-op).
    expect(called).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
