/**
 * Unit tests — OpenCode HTTP + SSE client (src/server/opencode/client.ts).
 *
 * Uses an injected fetchImpl so no real network is touched. Covers:
 *  - health(), createSession/init/prompt payload correctness
 *  - listModels / listProviders parsing
 *  - SSE subscribeEvents: data: frame parsing, heartbeat timeout, reconnect/backoff
 *  - prompt continuation (messageID passed through when present)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpencodeClient, resolveBaseUrl, OpencodeError } from "@/server/opencode";

/** A fetch stub that routes by (method, url) and returns a queued response. */
function fetchStub(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET") as string;
    const key = `${method} ${url}`;
    for (const [pattern, handler] of Object.entries(routes)) {
      if (pattern === key || (pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1)))) {
        return handler(new Request(url, { method, body: init?.body, headers: init?.headers }));
      }
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveBaseUrl", () => {
  it("env override beats caller default; strips trailing slash", () => {
    process.env.OPENCODE_BASE_URL = "http://custom:9999/";
    expect(resolveBaseUrl("http://fallback")).toBe("http://custom:9999");
    delete process.env.OPENCODE_BASE_URL;
    expect(resolveBaseUrl("http://fallback:1/")).toBe("http://fallback:1");
  });
});

describe("health", () => {
  it("returns true when healthy true", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/api/health": () => jsonResponse({ healthy: true }),
      }),
    });
    expect(await client.health()).toBe(true);
  });

  it("returns false on non-healthy body or network error", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/api/health": () => jsonResponse({ healthy: false }),
      }),
    });
    expect(await client.health()).toBe(false);

    const failing = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/api/health": () => {
          throw new Error("down");
        },
      }),
    });
    expect(await failing.health()).toBe(false);
  });
});

describe("session endpoints + prompt continuation", () => {
  it("createSession passes directory as a QUERY param (1.18.32 ignores body directory), body {} ", async () => {
    let url = "";
    let body: unknown;
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "POST http://oc:4096/session*": (req) => {
          url = req.url;
          return req.json().then((b) => {
            body = b;
            return jsonResponse({ id: "sess-1" });
          });
        },
      }),
    });
    const res = await client.createSession("/work");
    expect(res.id).toBe("sess-1");
    expect(url).toContain("/session?directory=%2Fwork");
    expect(body).toEqual({});
  });

  it("initSession posts to /session/{id}/init with model + provider", async () => {
    let body: unknown;
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "POST http://oc:4096/session/s1/init": (req) => {
          return req.json().then((b) => {
            body = b;
            return jsonResponse({});
          });
        },
      }),
    });
    await client.initSession("s1", { modelID: "glm-5.3", providerID: "ollama-cloud" });
    expect(body).toEqual({ modelID: "glm-5.3", providerID: "ollama-cloud" });
  });

  it("prompt posts to /session/{id}/message with the 1.18.32 {model, parts} body", async () => {
    let body: unknown;
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "POST http://oc:4096/session/s1/message": (req) => {
          return req.json().then((b) => {
            body = b;
            return jsonResponse({ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "ok" }] });
          });
        },
      }),
    });
    const res = await client.prompt("s1", { providerID: "ollama-cloud", modelID: "glm-5.3", prompt: "hi" });
    expect(body).toEqual({
      model: { providerID: "ollama-cloud", modelID: "glm-5.3" },
      parts: [{ type: "text", text: "hi" }],
    });
    expect(res).not.toBeNull();
  });

  it("prompt passes messageID/agent/system/noReply through when present", async () => {
    let body: unknown;
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "POST http://oc:4096/session/s1/message": (req) =>
          req.json().then((b) => {
            body = b;
            return jsonResponse({ info: {}, parts: [] });
          }),
      }),
    });
    await client.prompt("s1", { providerID: "p", modelID: "m", prompt: "hi", messageID: "msg-1", agent: "coder", system: "sys", noReply: true });
    expect(body).toEqual({
      model: { providerID: "p", modelID: "m" },
      parts: [{ type: "text", text: "hi" }],
      messageID: "msg-1",
      agent: "coder",
      system: "sys",
      noReply: true,
    });
  });

  it("promptAsync posts to /session/{id}/prompt_async (fire-and-forget) with the same body", async () => {
    let body: unknown;
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "POST http://oc:4096/session/s1/prompt_async": (req) =>
          req.json().then((b) => {
            body = b;
            return new Response(null, { status: 204 });
          }),
      }),
    });
    await client.promptAsync("s1", { providerID: "ollama-cloud", modelID: "glm-5.3", prompt: "go" });
    expect(body).toEqual({
      model: { providerID: "ollama-cloud", modelID: "glm-5.3" },
      parts: [{ type: "text", text: "go" }],
    });
  });

  it("replyQuestion sends answers as string[][] (1.18.32)", async () => {
    let body: unknown;
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "POST http://oc:4096/question/q1/reply": (req) =>
          req.json().then((b) => {
            body = b;
            return jsonResponse({});
          }),
      }),
    });
    await client.replyQuestion("q1", [["TypeScript"]]);
    expect(body).toEqual({ answers: [["TypeScript"]] });
  });

  it("listMessages GETs the SINGULAR /session/{id}/message and concatenates text parts", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/session/s1/message": () =>
          jsonResponse([
            { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "do the thing" }] },
            { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "{\"subtasks\":[]}" }] },
            { info: { id: "m3", role: "assistant" }, parts: [{ type: "text", text: "second reply" }, { type: "reasoning", text: "cot" }, { type: "text", text: "!" }] },
            { info: { id: "m4", role: "assistant" }, parts: [{ type: "tool", text: "" }] },
          ]),
      }),
    });
    const msgs = await client.listMessages("s1");
    // User dropped; reasoning/tool parts skipped; text parts concatenated.
    expect(msgs).toEqual([
      { id: "m2", role: "assistant", text: "{\"subtasks\":[]}" },
      { id: "m3", role: "assistant", text: "second reply\n!" },
    ]);
  });

  it("listMessages unwraps a { message: [...] } envelope and returns [] on unknowns", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/session/s1/message": () =>
          jsonResponse({ message: [{ info: { id: "a", role: "assistant" }, parts: [{ type: "text", text: "hi" }] }] }),
      }),
    });
    expect((await client.listMessages("s1")).length).toBe(1);

    const empty = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/session/s2/message": () => jsonResponse([]),
      }),
    });
    expect(await empty.listMessages("s2")).toEqual([]);
  });

  it("REGRESSION: a 200 text/html body from a JSON endpoint THROWS (SPA fallback guard)", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/api/model": () =>
          new Response("<!doctype html><html>SPA</html>", { status: 200, headers: { "content-type": "text/html" } }),
      }),
    });
    // Previously this silently returned undefined → listModels returned []. Now it throws.
    await expect(client.listModels()).rejects.toBeInstanceOf(OpencodeError);
  });
});

describe("listModels / listProviders", () => {
  it("listModels returns body.data or []", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/api/model": () =>
          jsonResponse({ data: [{ id: "glm-5.3", providerID: "ollama-cloud" }] }),
      }),
    });
    expect(await client.listModels()).toEqual([
      { id: "glm-5.3", providerID: "ollama-cloud" },
    ]);
  });

  it("listModels returns [] on missing data", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({ "GET http://oc:4096/api/model": () => jsonResponse({}) }),
    });
    expect(await client.listModels()).toEqual([]);
  });

  it("listProviders parses `all` + `connected`", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/api/provider": () =>
          jsonResponse({
            all: [{ id: "ollama-cloud", name: "Ollama Cloud" }],
            connected: ["ollama-cloud"],
          }),
      }),
    });
    const res = await client.listProviders();
    expect(res.providers).toHaveLength(1);
    expect(res.providers[0].name).toBe("Ollama Cloud");
    expect(res.connected).toEqual(["ollama-cloud"]);
  });

  it("listProviders degrades to empty on a 4xx (older server)", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/api/provider": () => new Response("nope", { status: 404 }),
      }),
    });
    expect(await client.listProviders()).toEqual({ providers: [], connected: [] });
  });

  it("prompt 500 throws OpencodeError", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "POST http://oc:4096/session/s1/message": () => new Response("bad", { status: 500 }),
      }),
    });
    await expect(
      client.prompt("s1", { providerID: "p", modelID: "m", prompt: "hi" }),
    ).rejects.toBeInstanceOf(OpencodeError);
  });
});

describe("subscribeEvents (SSE)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function sseClient(frames: string[]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(f));
        // Keep the stream open so heartbeat/reconnect logic can be exercised.
      },
    });
    return stream;
  }

  it("parses data: frames into events and reports open", async () => {
    const events: unknown[] = [];
    const statuses: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ type: "session.created", properties: { sessionID: "s1" } })}\n\n`),
        );
        // Close so the loop terminates deterministically for this test.
        controller.close();
      },
    });
    const client = new OpencodeClient({
      baseUrl: "http://oc:4096",
      fetchImpl: fetchStub({
        "GET http://oc:4096/event?directory=%2Fwork": () =>
          new Response(stream, { status: 200 }),
      }),
    });

    const unsub = client.subscribeEvents("/work", {
      onEvent: (ev) => events.push(ev),
      onStatus: (s) => statuses.push(s),
    });
    // Wait for async reader to drain.
    await new Promise((r) => setTimeout(r, 50));
    unsub();

    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe("session.created");
    expect(statuses).toContain("open");
  });

  it("reconnects with backoff when the stream ends (server closed)", async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const statuses: string[] = [];
    let calls = 0;

    const fetchImpl = vi.fn(() => {
      calls += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: {}\n\n"));
          c.close(); // server closes → triggers reconnect
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });

    const client = new OpencodeClient({ baseUrl: "http://oc:4096", fetchImpl });
    const unsub = client.subscribeEvents("/work", {
      onEvent: (ev) => events.push(ev),
      onStatus: (s) => statuses.push(s),
    });

    // Let the first connect resolve + the reconnect be scheduled.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100); // first backoff delay (base 100ms)
    await vi.advanceTimersByTimeAsync(0);

    unsub();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(statuses).toContain("reconnecting");
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("heartbeat timeout: no data for heartbeatTimeoutMs → tears down and reconnects", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls += 1;
      // A stream that never delivers data (stays open).
      const stream = new ReadableStream<Uint8Array>({});
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    const client = new OpencodeClient({ baseUrl: "http://oc:4096", fetchImpl });
    const statuses: string[] = [];
    const unsub = client.subscribeEvents("/work", {
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      heartbeatTimeoutMs: 200,
    });

    await vi.advanceTimersByTimeAsync(0); // connect open
    await vi.advanceTimersByTimeAsync(200); // heartbeat fires → abort & reconnect
    await vi.advanceTimersByTimeAsync(100); // backoff
    await vi.advanceTimersByTimeAsync(0);

    unsub();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("stops permanently when the external signal aborts", async () => {
    const ac = new AbortController();
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls += 1;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({}), { status: 200 }));
    });
    const client = new OpencodeClient({ baseUrl: "http://oc:4096", fetchImpl });
    const statuses: string[] = [];
    const unsub = client.subscribeEvents("/work", {
      signal: ac.signal,
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      heartbeatTimeoutMs: 50,
    });

    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const before = calls;
    // Give any scheduled reconnect a chance; none should fire after abort.
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(before);
    unsub();
    expect(statuses).toContain("closed");
  });
});
