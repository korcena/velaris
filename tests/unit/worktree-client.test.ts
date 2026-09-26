/**
 * Unit tests — OpenCode worktree client methods (Phase 6.2 Stage S1.1).
 *
 * Uses an injected fetchImpl so no real network is touched. Pins the
 * live-verified endpoint shapes:
 *   POST   /experimental/worktree        {name?, startCommand?} → {name,branch,directory}
 *   GET    /experimental/worktree        → string[] (non-array tolerated)
 *   POST   /experimental/worktree/reset  {directory} → boolean (truthy tolerated)
 *   DELETE /experimental/worktree        {directory} → boolean (truthy tolerated)
 *
 * The live round-trip is exercised separately by the opt-in `@real` test
 * (`opencode-worktree-real.test.ts`), which never runs in the default gate.
 */

import { describe, it, expect } from "vitest";
import { OpencodeClient } from "@/server/opencode";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Captured {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Build a client whose only fetch route captures the request and returns the
 * given response. `captured` is populated on each call.
 */
function captureClient(response: Response | (() => Response)): {
  client: OpencodeClient;
  captured: Captured;
} {
  const captured: Captured = { method: "", url: "", body: undefined };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.method = init?.method ?? "GET";
    captured.url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return typeof response === "function" ? response() : response;
  }) as unknown as typeof fetch;
  return { client: new OpencodeClient({ baseUrl: "http://oc:4096", fetchImpl }), captured };
}

describe("OpencodeClient.createWorktree", () => {
  it("POSTs {name, startCommand} and returns the parsed worktree info", async () => {
    const { client, captured } = captureClient(
      jsonResponse({ name: "task-42", branch: "opencode/task-42", directory: "/wt/task-42" }),
    );
    const info = await client.createWorktree({ name: "task-42", startCommand: "npm i" });
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("http://oc:4096/experimental/worktree");
    expect(captured.body).toEqual({ name: "task-42", startCommand: "npm i" });
    expect(info).toEqual({
      name: "task-42",
      branch: "opencode/task-42",
      directory: "/wt/task-42",
    });
  });

  it("tolerates a missing opts body and missing fields (empty POST body, coerced strings)", async () => {
    const { client, captured } = captureClient(jsonResponse({}));
    const info = await client.createWorktree();
    expect(captured.method).toBe("POST");
    expect(captured.body).toEqual({});
    expect(info).toEqual({ name: "", branch: "", directory: "" });
  });
});

describe("OpencodeClient.listWorktrees", () => {
  it("GETs /experimental/worktree and returns a string[]", async () => {
    const { client, captured } = captureClient(jsonResponse(["/wt/a", "/wt/b"]));
    expect(await client.listWorktrees()).toEqual(["/wt/a", "/wt/b"]);
    expect(captured.method).toBe("GET");
    expect(captured.url).toBe("http://oc:4096/experimental/worktree");
  });

  it("coerces a non-array body to an empty array", async () => {
    const { client } = captureClient(jsonResponse({ unexpected: true }));
    expect(await client.listWorktrees()).toEqual([]);
  });
});

describe("OpencodeClient.resetWorktree / deleteWorktree", () => {
  it("reset POSTs {directory} to /experimental/worktree/reset and returns true", async () => {
    const { client, captured } = captureClient(jsonResponse(true));
    expect(await client.resetWorktree("/wt/a")).toBe(true);
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("http://oc:4096/experimental/worktree/reset");
    expect(captured.body).toEqual({ directory: "/wt/a" });
  });

  it("delete DELETEs /experimental/worktree with {directory} and returns true", async () => {
    const { client, captured } = captureClient(jsonResponse(true));
    expect(await client.deleteWorktree("/wt/a")).toBe(true);
    expect(captured.method).toBe("DELETE");
    expect(captured.url).toBe("http://oc:4096/experimental/worktree");
    expect(captured.body).toEqual({ directory: "/wt/a" });
  });

  it("tolerates {ok:true} as a success for reset and delete", async () => {
    const reset = captureClient(jsonResponse({ ok: true })).client;
    const del = captureClient(jsonResponse({ ok: true })).client;
    expect(await reset.resetWorktree("/wt/a")).toBe(true);
    expect(await del.deleteWorktree("/wt/a")).toBe(true);
  });

  it("treats {ok:false} and false as failure", async () => {
    const okFalse = captureClient(jsonResponse({ ok: false })).client;
    const plainFalse = captureClient(jsonResponse(false)).client;
    expect(await okFalse.resetWorktree("/wt/a")).toBe(false);
    expect(await plainFalse.deleteWorktree("/wt/a")).toBe(false);
  });
});
