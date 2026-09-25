/**
 * Ollama HTTP client — typed, dependency-free client for the native Ollama
 * HTTP API (Phase 5 decision Q1: raw `fetch`, no npm dependency).
 *
 * Endpoint set this client uses:
 *   GET  /api/version            health()
 *   GET  /api/tags               listModels()
 *   POST /api/chat               chat()  (always stream:false, tools[]/messages[])
 *
 * Convention mirrors src/server/opencode/client.ts:
 *  - injectable `fetchImpl` + `baseUrl` for unit tests (no network);
 *  - a non-JSON/HTML success body from a JSON endpoint is a hard error
 *    (guards against a silently-returned server fallback page);
 *  - `health()` never throws — any failure resolves false (honest "unreachable").
 *
 * Base-URL precedence lives in the engine helper (default provider config →
 * `OLLAMA_BASE_URL` env → DEFAULT_PROVIDER_BASE_URLS.ollama). `resolveOllamaBaseUrl`
 * gives callers the env-first resolution, mirroring OpenCode's `resolveBaseUrl`.
 */

import type {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaTag,
} from "./types";

export class OllamaError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "OllamaError";
    this.status = status;
  }
}

/** Resolve the Ollama base URL: env override beats caller-provided default. */
export function resolveOllamaBaseUrl(fallbackDefault?: string): string {
  return (process.env.OLLAMA_BASE_URL ?? fallbackDefault ?? "http://localhost:11434").replace(
    /\/+$/,
    "",
  );
}

export interface OllamaClientOptions {
  baseUrl?: string;
  /** fetch-compatible signal (used by the engine for shutdown). */
  signal?: AbortSignal;
  /** fetch impl override (tests). */
  fetchImpl?: typeof fetch;
}

export class OllamaClient {
  readonly baseUrl: string;
  private readonly signal?: AbortSignal;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaClientOptions = {}) {
    this.baseUrl = resolveOllamaBaseUrl(opts.baseUrl);
    this.signal = opts.signal;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: this.signal,
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e?.name === "AbortError") throw e;
      throw new OllamaError(`Ollama request failed for ${path}: ${e?.message ?? "network error"}`);
    }
    if (!res.ok) {
      let detail = "";
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html")) {
        try {
          const text = await res.text();
          detail = text.slice(0, 300);
        } catch {
          /* ignore body read error */
        }
      } else {
        detail = "(HTML response — is this really the Ollama server?)";
      }
      throw new OllamaError(`Ollama ${method} ${path} failed (${res.status}): ${detail}`, res.status);
    }
    const ct = res.headers.get("content-type") ?? "";
    // Guard: a non-JSON (e.g. HTML) 200 body from a JSON endpoint must be a hard
    // error, not a silent success after a failed JSON.parse.
    if (ct.includes("text/html")) {
      throw new OllamaError(
        `Ollama ${method} ${path} returned HTTP ${res.status} with non-JSON content-type "${ct}" — not an Ollama JSON response`,
        res.status,
      );
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new OllamaError(
        `Ollama ${method} ${path} returned HTTP ${res.status} with a non-JSON body (content-type "${ct}")`,
        res.status,
      );
    }
  }

  /* ---------------- health & models ---------------- */

  /** Health probe — GET /api/version. Returns true on a 200 JSON body and
   * false on ANY failure (down server, non-JSON guard, network). Never throws. */
  async health(): Promise<boolean> {
    try {
      await this.request<Record<string, unknown>>("GET", "/api/version");
      return true;
    } catch {
      return false;
    }
  }

  /** List installed models — GET /api/tags → models[].name. Tolerates unknown shape. */
  async listModels(): Promise<string[]> {
    const body = await this.request<{ models?: OllamaTag[] }>("GET", "/api/tags");
    if (!Array.isArray(body?.models)) return [];
    return body.models
      .map((m) => (m && typeof m.name === "string" ? m.name : ""))
      .filter((n): n is string => n.length > 0);
  }

  /* ---------------- chat ---------------- */

  /** One model turn — POST /api/chat with stream:false, tools[], messages[].
   * Throws `OllamaError` on a non-2xx/network/non-JSON failure. A 200 body that
   * carries an `error` field is tolerated and returned so the caller can decide. */
  async chat(req: OllamaChatRequest): Promise<OllamaChatResponse> {
    const body = await this.request<OllamaChatResponse>("POST", "/api/chat", {
      model: req.model,
      messages: req.messages,
      ...(req.tools ? { tools: req.tools } : {}),
      stream: false,
      ...(req.options ? { options: req.options } : {}),
    });
    if (!body || typeof body !== "object") {
      throw new OllamaError("Ollama chat returned an invalid response body");
    }
    return body;
  }
}
