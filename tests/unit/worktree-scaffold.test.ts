/**
 * Unit tests — worktree isolation scaffold (Phase 5 Stage I — Q7, default OFF).
 *
 * This stage is deliberately INERT: `experimental.worktreeIsolation` defaults to
 * false and, when off, NO code path invokes the OpenCode `/experimental/worktree`
 * endpoint (unverifiable without a live server). We prove:
 *  - the flag defaults to false (off path ⇒ no behavior change);
 *  - when the flag is ON the scaffold method's request shape is asserted. The
 *    live isolation behaviour is explicitly NOT verified.
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

describe("OpencodeClient.worktree — scaffold request shape only (no live claim)", () => {
  it("is inert by default: the method exists but is not auto-invoked by the client", () => {
    let called = false;
    const fetchImpl = vi.fn(async () => {
      called = true;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    expect(typeof client.worktree).toBe("function");
    // Constructing the client never calls worktree (the flag-off path is a no-op).
    expect(called).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("invokes GET /experimental/worktree?directory= when a caller opts in (request shape only, unverified)", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      new Response(JSON.stringify({ ok: true, isolated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    const res = await client.worktree("/tmp/work");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledWith = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(calledWith)).toMatch(/\/experimental\/worktree\?directory=%2Ftmp%2Fwork$/);
    expect(res).toMatchObject({ ok: true, isolated: true });
  });
});
