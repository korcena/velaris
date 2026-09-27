/**
 * Opt-in `@real` test — live OpenCode worktree round-trip (Phase 6.2 Stage S1.1).
 *
 * This is the only place the new client methods (`createWorktree`,
 * `listWorktrees`, `resetWorktree`, `deleteWorktree`) are exercised against a
 * real OpenCode server. It is DOUBLE-gated and therefore NEVER runs as part of
 * the default `npm test` gate:
 *   1. `VELARIS_REAL_TESTS=1` must be set (explicit opt-in), AND
 *   2. a live server must answer at OPENCODE_BASE_URL (default :4096) — probed in
 *      `beforeAll`; each test calls `ctx.skip()` when the probe failed.
 *
 * (The reachability probe cannot be used directly in `describe.skipIf` because
 * this project compiles with `target: es5`, which forbids top-level await; the
 * synchronous env gate plus a runtime probe is equivalent and still ensures the
 * suite is skipped — with no network call — unless explicitly opted in.)
 *
 * Run it with:  VELARIS_REAL_TESTS=1 npx vitest run tests/unit/opencode-worktree-real.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { OpencodeClient, resolveBaseUrl } from "@/server/opencode";

const OPTED_IN = process.env.VELARIS_REAL_TESTS === "1";

let live = false;

async function canReachOpenCode(): Promise<boolean> {
  if (!OPTED_IN) return false;
  const baseUrl = resolveBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!OPTED_IN)("@real OpenCode worktree round-trip", () => {
  beforeAll(async () => {
    live = await canReachOpenCode();
  });

  it("creates, lists, resets and deletes a worktree", async (ctx) => {
    if (!live) ctx.skip();
    const client = new OpencodeClient({ baseUrl: resolveBaseUrl() });
    // M2: bind the worktree to THIS repo via the required ?directory= param.
    const sourceRepo = process.cwd();
    const info = await client.createWorktree({
      directory: sourceRepo,
      name: `velaris-real-${Date.now()}`,
    });
    expect(typeof info.name).toBe("string");
    expect(typeof info.branch).toBe("string");
    expect(typeof info.directory).toBe("string");
    expect(info.directory.length).toBeGreaterThan(0);

    const listed = await client.listWorktrees();
    expect(listed).toContain(info.directory);

    expect(await client.resetWorktree(info.directory)).toBe(true);
    expect(await client.deleteWorktree(info.directory)).toBe(true);
  });
});
