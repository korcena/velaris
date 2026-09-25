/**
 * Unit tests — Ollama HTTP client (src/server/execution/ollama/client.ts).
 *
 * Uses an injected fetchImpl so no real network is touched. Covers:
 *  - resolveOllamaBaseUrl env precedence + trailing-slash strip
 *  - health(): true/false on version 200 / error / network-down
 *  - listModels(): parses models[].name, tolerates unknown shape
 *  - chat(): posts {model, messages, tools, stream:false}, parses tool_calls /
 *    prompt_eval_count / eval_count; throws OllamaError on non-2xx; tolerates an
 *    `error` field in a 200 body; guards non-JSON/HTML bodies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OllamaClient,
  OllamaError,
  resolveOllamaBaseUrl,
} from "@/server/execution/ollama/client";

/** A fetch stub that routes by (method, key) and returns a queued response. */
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

const BASE = "http://ollama:11434";

afterEach(() => {
  delete process.env.OLLAMA_BASE_URL;
});

describe("resolveOllamaBaseUrl", () => {
  it("env override beats caller default; strips trailing slash", () => {
    process.env.OLLAMA_BASE_URL = "http://custom:9999/";
    expect(resolveOllamaBaseUrl("http://fallback")).toBe("http://custom:9999");
    delete process.env.OLLAMA_BASE_URL;
    expect(resolveOllamaBaseUrl("http://fallback:1/")).toBe("http://fallback:1");
  });

  it("defaults to localhost:11434 when nothing is set", () => {
    expect(resolveOllamaBaseUrl()).toBe("http://localhost:11434");
  });
});

describe("health", () => {
  it("returns true on a 200 /api/version", async () => {
    const client = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({ "GET http://ollama:11434/api/version": () => jsonResponse({ version: "0.5.1" }) }),
    });
    expect(await client.health()).toBe(true);
  });

  it("returns false on a non-200 / non-JSON / network error (honest unreachable)", async () => {
    const non200 = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({ "GET http://ollama:11434/api/version": () => new Response("boom", { status: 500 }) }),
    });
    expect(await non200.health()).toBe(false);

    // HTML guard — a 200 HTML body must NOT be treated as healthy.
    const html = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({
        "GET http://ollama:11434/api/version": () =>
          new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      }),
    });
    expect(await html.health()).toBe(false);

    // Network-down / connection refused.
    const down = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({ "GET http://ollama:11434/api/version": () => { throw new Error("ECONNREFUSED"); } }),
    });
    expect(await down.health()).toBe(false);
  });
});

describe("listModels", () => {
  it("parses models[].name", async () => {
    const client = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({
        "GET http://ollama:11434/api/tags": () =>
          jsonResponse({ models: [{ name: "llama3.1:8b" }, { name: "qwen2.5-coder" }] }),
      }),
    });
    expect(await client.listModels()).toEqual(["llama3.1:8b", "qwen2.5-coder"]);
  });

  it("tolerates an unknown shape (missing/empty models) → []", async () => {
    const empty = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({ "GET http://ollama:11434/api/tags": () => jsonResponse({}) }),
    });
    expect(await empty.listModels()).toEqual([]);

    const notArr = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({ "GET http://ollama:11434/api/tags": () => jsonResponse({ models: "nope" }) }),
    });
    expect(await notArr.listModels()).toEqual([]);
  });
});

describe("chat", () => {
  it("posts {model, messages, tools, stream:false} and parses tool_calls + counts", async () => {
    let sentBody: unknown;
    const client = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({
        "POST http://ollama:11434/api/chat": (req) =>
          req.json().then((b) => {
            sentBody = b;
            return jsonResponse({
              message: {
                role: "assistant",
                content: "let me check",
                tool_calls: [
                  {
                    function: {
                      name: "fs_read",
                      arguments: { path: "/work/a.txt" },
                    },
                  },
                ],
              },
              prompt_eval_count: 10,
              eval_count: 5,
              done: false,
            });
          }),
      }),
    });
    const res = await client.chat({
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [{ type: "function", function: { name: "fs_read", description: "x", parameters: {} } }],
    });
    expect(sentBody).toMatchObject({
      model: "llama3.1:8b",
      stream: false,
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [
        { type: "function", function: { name: "fs_read", description: "x", parameters: {} } },
      ],
    });
    expect(res.message.role).toBe("assistant");
    expect(res.message.tool_calls).toHaveLength(1);
    expect(res.message.tool_calls![0].function.name).toBe("fs_read");
    expect(res.prompt_eval_count).toBe(10);
    expect(res.eval_count).toBe(5);
    expect(res.done).toBe(false);
  });

  it("omits tools when none are provided", async () => {
    let sentBody: Record<string, unknown> = {};
    const client = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({
        "POST http://ollama:11434/api/chat": (req) =>
          req.json().then((b) => {
            sentBody = b as Record<string, unknown>;
            return jsonResponse({ message: { role: "assistant", content: "ok" }, done: true });
          }),
      }),
    });
    await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect("tools" in sentBody).toBe(false);
    expect(sentBody.stream).toBe(false);
  });

  it("throws OllamaError on a non-2xx response", async () => {
    const client = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({
        "POST http://ollama:11434/api/chat": () => new Response("bad model", { status: 500 }),
      }),
    });
    await expect(
      client.chat({ model: "unknown", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(OllamaError);
  });

  it("tolerates an `error` field carried in a 200 body (does not throw)", async () => {
    const client = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({
        "POST http://ollama:11434/api/chat": () =>
          jsonResponse({ error: "model not found", done: false, message: { role: "assistant", content: "" } }),
      }),
    });
    const res = await client.chat({ model: "nope", messages: [{ role: "user", content: "hi" }] });
    expect(res.error).toBe("model not found");
  });

  it("throws OllamaError on a 200 non-JSON/HTML successful body", async () => {
    const html = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({
        "POST http://ollama:11434/api/chat": () =>
          new Response("<!doctype html><html>UI</html>", { status: 200, headers: { "content-type": "text/html" } }),
      }),
    });
    await expect(html.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(
      OllamaError,
    );

    const plain = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({
        "POST http://ollama:11434/api/chat": () =>
          new Response("not json at all", { status: 200, headers: { "content-type": "text/plain" } }),
      }),
    });
    await expect(plain.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(
      OllamaError,
    );
  });

  it("throws OllamaError on a network error / connection refused", async () => {
    const client = new OllamaClient({
      baseUrl: BASE,
      fetchImpl: fetchStub({
        "POST http://ollama:11434/api/chat": () => { throw new Error("ECONNREFUSED"); },
      }),
    });
    await expect(client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(
      OllamaError,
    );
  });
});
