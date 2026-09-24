/**
 * OpenCode client — thin typed HTTP + SSE client for the installed OpenCode
 * server (v1.18.32). Builds against the live-verified endpoint shapes.
 *
 * Verified endpoint set this client uses:
 *   GET  /api/health                                  health()
 *   GET  /api/model                                   listModels()
 *   POST /session {directory?}                        createSession()
 *   POST /session/{id}/message                         prompt()  → reply after turn
 *   POST /session/{id}/prompt_async                    promptAsync() → 204, SSE flow
 *   POST /session/{id}/abort                           abortSession()
 *   GET  /session/{id}                                 getSession()
 *   GET  /session/{id}/message                         listMessages() (SINGULAR transcript)
 *   GET  /session/{id}/diff                            getSessionDiff()
 *   GET  /session                                      listSessions()
 *   GET  /permission                                   listPendingPermissions()
 *   POST /permission/{requestID}/reply                 replyPermission()
 *   GET  /question                                     listPendingQuestions()
 *   POST /question/{requestID}/reply                   replyQuestion()
 *   POST /question/{requestID}/reject                  rejectQuestion()
 *   GET  /event?directory=<abs>                        subscribeEvents()  (SSE)
 *
 * Explicit limitations (never simulated):
 *  - NO pause/resume endpoints exist. abortSession is the only interruption.
 *  - The SSE /event stream is directory-scoped; one consumer per working dir.
 *  - Missing routes on 1.18.32 return HTTP 200 + SPA HTML (not 404), so a
 *    non-JSON success body from a JSON endpoint is a hard error (see request()).
 */

import type {
  SessionInfo,
  SessionPart,
  SessionMessageRaw,
  SessionMessage,
  PermissionRequest,
  QuestionRequest,
  SessionDiffEntry,
  ProviderEvent,
} from "./types";

export class OpencodeError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "OpencodeError";
    this.status = status;
  }
}

/** Resolve the OpenCode base URL: env override beats caller-provided default. */
export function resolveBaseUrl(fallbackDefault?: string): string {
  return (process.env.OPENCODE_BASE_URL ?? fallbackDefault ?? "http://127.0.0.1:4096").replace(
    /\/+$/,
    "",
  );
}

export interface OpencodeClientOptions {
  baseUrl?: string;
  /** fetch-compatible signal (used by the engine for shutdown). */
  signal?: AbortSignal;
  /** fetch impl override (tests). */
  fetchImpl?: typeof fetch;
}

export interface PromptOptions {
  providerID: string;
  modelID: string;
  prompt: string;
  /** Optional continuation message id (^msg). */
  messageID?: string;
  /** Agent persona id (1.18.32 `agent` field). */
  agent?: string;
  /** System prompt (1.18.32 `system` field). Optional; the adapter composes it
   * into the prompt text already. */
  system?: string;
  /** Whether to fire-and-forget (prompt_async). Default false → use /message.
   * The engine prefers prompt_async for streaming. */
  noReply?: boolean;
}

export class OpencodeClient {
  readonly baseUrl: string;
  private readonly signal?: AbortSignal;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpencodeClientOptions = {}) {
    this.baseUrl = resolveBaseUrl(opts.baseUrl);
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
      throw new OpencodeError(`OpenCode request failed for ${path}: ${e?.message ?? "network error"}`, 503);
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
        detail = "(SPA HTML — route missing on the OpenCode server?)";
      }
      throw new OpencodeError(`OpenCode ${method} ${path} failed (${res.status}): ${detail}`, res.status);
    }
    // 204 / empty — no body to parse (prompt_async).
    if (res.status === 204) return undefined as T;

    const ct = res.headers.get("content-type") ?? "";
    // Guard: a missing route on 1.18.32 returns HTTP 200 + SPA HTML, which would
    // otherwise look like a silent success after a failed JSON.parse. Detect it.
    if (ct.includes("text/html")) {
      throw new OpencodeError(
        `OpenCode ${method} ${path} returned HTTP ${res.status} with non-JSON content-type "${ct}" — likely a missing route / SPA fallback`,
        res.status,
      );
    }
    try {
      return (await res.json()) as T;
    } catch {
      // Non-JSON success body from a JSON endpoint is treated as the SPA-fallback
      // class of failure too — throw rather than silently returning undefined.
      throw new OpencodeError(
        `OpenCode ${method} ${path} returned HTTP ${res.status} with a non-JSON body (content-type "${ct}") — likely a missing route / SPA fallback`,
        res.status,
      );
    }
  }

  /* ---------------- health & models ---------------- */

  async health(): Promise<boolean> {
    try {
      const body = await this.request<{ healthy?: boolean }>("GET", "/api/health");
      return body?.healthy === true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<Array<{ id: string; providerID: string }>> {
    const body = await this.request<{ data?: Array<{ id: string; providerID: string }> }>(
      "GET",
      "/api/model",
    );
    return body?.data ?? [];
  }

  /**
   * List all providers (OpenCode: GET /api/provider). Returns the raw provider
   * objects plus the connected provider ids — used to enrich the model list with
   * a human-readable provider label in the /api/models picker.
   */
  async listProviders(): Promise<{
    providers: Array<{ id?: string; name?: string; [key: string]: unknown }>;
    connected: string[];
  }> {
    let body: Record<string, unknown>;
    try {
      body = await this.request<Record<string, unknown>>("GET", "/api/provider");
    } catch (err) {
      // The provider endpoint may not exist on older OpenCode server builds;
      // tolerate it so the model picker still works (providers are enriched
      // best-effort).
      const e = err as { status?: number };
      if (e?.status && e.status >= 400 && e.status < 500) {
        return { providers: [], connected: [] };
      }
      throw err;
    }
    const all = Array.isArray(body?.all) ? (body.all as Record<string, unknown>[]) : [];
    const connected = Array.isArray(body?.connected)
      ? (body.connected as string[]).filter((s): s is string => typeof s === "string")
      : [];
    return {
      providers: all.map((p) => {
        const rec = p as Record<string, unknown>;
        return {
          id: typeof rec.id === "string" ? rec.id : undefined,
          name: typeof rec.name === "string" ? rec.name : undefined,
          ...rec,
        };
      }),
      connected,
    };
  }

  /* ---------------- sessions ---------------- */

  async createSession(directory?: string): Promise<{ id: string }> {
    // 1.18.32 IGNORES a `{directory}` in the request BODY and always roots the
    // session at the server's launch directory. It honours `directory` only as a
    // QUERY param. So we append it to the path and keep the body `{}`.
    const query = directory !== undefined && directory.length > 0
      ? `?directory=${encodeURIComponent(directory)}`
      : "";
    const body = await this.request<{ id: string }>(
      "POST",
      `/session${query}`,
      {},
    );
    if (!body?.id) throw new OpencodeError("OpenCode createSession returned no id");
    return body;
  }

  /**
   * (Kept for completeness/back-compat, NOT used by the adapter start path.) In
   * 1.18.32 `init` is optional for prompting and requires a provider-backed
   * messageID (`^msg`); we never invent one. The adapter just creates a session
   * and prompts it directly.
   */
  async initSession(id: string, opts?: { modelID?: string; providerID?: string }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (opts?.modelID) body.modelID = opts.modelID;
    if (opts?.providerID) body.providerID = opts.providerID;
    await this.request<unknown>("POST", `/session/${encodeURIComponent(id)}/init`, body);
  }

  /** Compose the 1.18.32 prompt body. Shared by prompt() and promptAsync(). */
  private promptBody(opts: PromptOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: { providerID: opts.providerID, modelID: opts.modelID },
      parts: [{ type: "text", text: opts.prompt }],
    };
    if (opts.messageID) body.messageID = opts.messageID;
    if (opts.agent) body.agent = opts.agent;
    if (opts.system) body.system = opts.system;
    if (opts.noReply) body.noReply = true;
    return body;
  }

  /**
   * Synchronous prompt — POST /session/{id}/message. Returns after the whole
   * turn completes (no streaming). Assistant text lives in `parts[].text` where
   * `part.type === 'text'`; `info` carries cost/tokens/time. Returns the parsed
   * response or null.
   */
  async prompt(id: string, opts: PromptOptions): Promise<Record<string, unknown> | null> {
    const result = await this.request<Record<string, unknown>>(
      "POST",
      `/session/${encodeURIComponent(id)}/message`,
      this.promptBody(opts),
    );
    return result ?? null;
  }

  /**
   * Fire-and-forget prompt — POST /session/{id}/prompt_async. Returns 204
   * immediately; the model then runs and events flow over the /event SSE. This
   * is the right call for the engine's streaming model (the runner's quiet
   * watchdog + SSE ingest design).
   */
  async promptAsync(id: string, opts: PromptOptions): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/session/${encodeURIComponent(id)}/prompt_async`,
      this.promptBody(opts),
    );
  }

  async abortSession(id: string): Promise<void> {
    await this.request<unknown>("POST", `/session/${encodeURIComponent(id)}/abort`, {});
  }

  async getSession(id: string): Promise<SessionInfo> {
    const body = await this.request<Record<string, unknown>>("GET", `/session/${encodeURIComponent(id)}`);
    return normalizeSessionInfo(body);
  }

  /**
   * Fetch the session transcript — OpenCode 1.18.32 uses the SINGULAR route
   * `GET /session/{id}/message` (the plural `/messages` returns SPA HTML). Returns
   * `Array<{ info, parts }>`; we normalize to SessionMessage[] by concatenating
   * each message's assistant text `parts[].text` where `part.type === 'text'`,
   * dropping user messages. Tolerantly typed — unknown part types are skipped.
   */
  async listMessages(providerSessionId: string): Promise<SessionMessage[]> {
    const raw = await this.request<SessionMessageRaw[] | Record<string, unknown>>(
      "GET",
      `/session/${encodeURIComponent(providerSessionId)}/message`,
    );
    let arr: SessionMessageRaw[] = [];
    if (Array.isArray(raw)) arr = raw as SessionMessageRaw[];
    else if (raw && Array.isArray((raw as Record<string, unknown>).message)) {
      arr = (raw as { message: SessionMessageRaw[] }).message;
    }
    const out: SessionMessage[] = [];
    for (const m of arr) {
      const info = (m?.info ?? {}) as Record<string, unknown>;
      const role = typeof info.role === "string" ? info.role.toLowerCase() : "";
      const isAssistant = ["assistant", "model", "agent", "assistant-message"].includes(role);
      if (!isAssistant) continue;
      const text = extractPartsText(m?.parts ?? []);
      if (!text) continue;
      out.push({
        id: typeof info.id === "string" ? info.id : undefined,
        role: "assistant",
        text,
      });
    }
    return out;
  }

  async listSessions(): Promise<SessionInfo[]> {
    const body = await this.request<Record<string, unknown>[]>("GET", "/session");
    return Array.isArray(body) ? body.map(normalizeSessionInfo) : [];
  }

  async getSessionDiff(id: string): Promise<SessionDiffEntry[]> {
    const body = await this.request<SessionDiffEntry[]>("GET", `/session/${encodeURIComponent(id)}/diff`);
    return Array.isArray(body) ? body : [];
  }

  /* ---------------- permissions ---------------- */

  async listPendingPermissions(): Promise<PermissionRequest[]> {
    const body = await this.request<PermissionRequest[]>("GET", "/permission");
    return Array.isArray(body) ? body : [];
  }

  async replyPermission(
    requestID: string,
    req: { reply: "once" | "always" | "reject"; message?: string },
  ): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/permission/${encodeURIComponent(requestID)}/reply`,
      req,
    );
  }

  /* ---------------- questions ---------------- */

  async listPendingQuestions(): Promise<QuestionRequest[]> {
    const body = await this.request<QuestionRequest[]>("GET", "/question");
    return Array.isArray(body) ? body : [];
  }

  async replyQuestion(requestID: string, answers: string[][]): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/question/${encodeURIComponent(requestID)}/reply`,
      { answers },
    );
  }

  async rejectQuestion(requestID: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/question/${encodeURIComponent(requestID)}/reject`,
      {},
    );
  }

  /* ---------------- SSE /event stream ---------------- */

  /**
   * Subscribe to the OpenCode event stream for a project directory.
   * Emits each parsed ProviderEvent via onEvent. Auto-reconnects with
   * exponential backoff (100ms → max 30s, reset on success). If no data
   * arrives for `heartbeatTimeoutMs` (default 60s) the connection is torn down
   * and re-established (heartbeat/timeout detection).
   *
   * Returns an unsubscribe function. Never throws after subscription starts —
   * errors are surfaced by closing/reconnecting. Stops permanently when the
   * provided signal aborts.
   */
  subscribeEvents(
    directory: string,
    opts: {
      signal?: AbortSignal;
      onEvent: (ev: ProviderEvent) => void;
      onStatus?: (s: "connecting" | "open" | "reconnecting" | "closed") => void;
      heartbeatTimeoutMs?: number;
    },
  ): () => void {
    let running = true;
    let retry = 0;
    let timer: NodeJS.Timeout | null = null;
    let controller: AbortController | null = null;

    const baseDelay = 100;
    const maxDelay = 30_000;
    const heartbeatMs = opts.heartbeatTimeoutMs ?? 60_000;

    const backoffDelay = () => {
      const d = Math.min(maxDelay, baseDelay * 2 ** retry);
      retry += 1;
      return d;
    };

    const clearHearbeat = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const armHeartbeat = () => {
      clearHearbeat();
      timer = setTimeout(() => {
        // No bytes for heartbeatMs → assume dead stream, reconnect.
        controller?.abort();
        schedule();
      }, heartbeatMs);
    };

    const teardown = () => {
      clearHearbeat();
      controller?.abort();
      controller = null;
    };

    const connect = () => {
      if (!running) return;
      opts.onStatus?.("connecting");
      controller = new AbortController();
      const own = controller.signal;
      const external = opts.signal;
      const onExternalAbort = () => controller?.abort();

      if (external?.aborted) {
        running = false;
        opts.onStatus?.("closed");
        return;
      }
      external?.addEventListener("abort", onExternalAbort, { once: true });

      void (async () => {
        try {
          const res = await this.fetchImpl(
            `${this.baseUrl}/event?directory=${encodeURIComponent(directory)}`,
            { signal: own },
          );
          if (!res.ok || !res.body) {
            throw new OpencodeError(`SSE /event status ${res.status}`);
          }
          external?.removeEventListener("abort", onExternalAbort);
          if (!running) return;
          opts.onStatus?.("open");
          retry = 0; // success resets backoff

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          // Heartbeat: any received data counts as liveness.
          armHeartbeat();

          while (running && !own.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            armHeartbeat();
            // SSE frames are separated by a blank line.
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const rawFrame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const dataLines = rawFrame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim());
              if (dataLines.length === 0) continue;
              const json = dataLines.join("\n");
              try {
                const ev = JSON.parse(json) as ProviderEvent;
                opts.onEvent(ev);
              } catch {
                // Parse failure — drop the frame but keep the stream alive.
              }
            }
          }
          clearHearbeat();
          if (running && !own.aborted) {
            // Stream ended (server closed) → reconnect.
            schedule();
          }
        } catch (err) {
          const e = err as { name?: string };
          if (e?.name === "AbortError") {
            // Only reconnect if the external signal didn't cancel us.
            if (!external?.aborted) schedule();
            else {
              running = false;
              opts.onStatus?.("closed");
            }
          } else if (running && !external?.aborted) {
            opts.onStatus?.("reconnecting");
            schedule();
          }
        }
      })();
    };

    const schedule = () => {
      if (!running) return;
      clearHearbeat();
      const delay = backoffDelay();
      opts.onStatus?.("reconnecting");
      setTimeout(connect, delay);
    };

    connect();

    return () => {
      running = false;
      clearHearbeat();
      controller?.abort();
      controller = null;
      opts.onStatus?.("closed");
    };
  }
}

/** Tolerantly coerce an OpenCode session object into our SessionInfo type. */
function normalizeSessionInfo(input: Record<string, unknown>): SessionInfo {
  const tokensMap = (input.tokens ?? {}) as Record<string, unknown>;
  const cache = (tokensMap.cache ?? {}) as Record<string, unknown>;
  const model = (input.model ?? {}) as Record<string, unknown>;
  const time = (input.time ?? {}) as Record<string, unknown>;
  return {
    id: typeof input.id === "string" ? input.id : "",
    cost: typeof input.cost === "number" ? input.cost : 0,
    tokens: {
      input: typeof tokensMap.input === "number" ? tokensMap.input : 0,
      output: typeof tokensMap.output === "number" ? tokensMap.output : 0,
      reasoning: typeof tokensMap.reasoning === "number" ? tokensMap.reasoning : 0,
      cacheRead:
        typeof cache.read === "number"
          ? cache.read
          : typeof cache === "number"
            ? (cache as number)
            : 0,
    },
    model: {
      id: typeof model.id === "string" ? model.id : "",
      providerID: typeof model.providerID === "string" ? model.providerID : "",
    },
    time: {
      created: typeof time.created === "number" ? time.created : 0,
      updated: typeof time.updated === "number" ? time.updated : 0,
    },
    title: typeof input.title === "string" ? input.title : "",
    directory: typeof input.directory === "string" ? input.directory : null,
  };
}

/**
 * Concatenate the assistant-facing text from a transcript message's parts.
 * Only `parts[].text` where `part.type === 'text'` is surfaced; all other part
 * types (reasoning, tool, snapshot, patch, step-start/finish, compaction, ...)
 * are skipped so chain-of-thought and structural frames never become content.
 */
function extractPartsText(parts: SessionPart[]): string {
  return (Array.isArray(parts) ? parts : [])
    .map((p) => {
      if (p && p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    })
    .filter((t): t is string => t.length > 0)
    .join("\n")
    .trim();
}
