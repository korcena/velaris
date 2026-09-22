/**
 * OpenCode client — thin typed HTTP + SSE client for the verified OpenCode
 * server endpoints (v1.18.31). Builds against the exact calls I tested, per
 * IMPLEMENTATION_PLAN §2 / ARCHITECTURE §7. No invented endpoints.
 *
 * Verified endpoint set this client uses:
 *   GET  /api/health                                  health()
 *   GET  /api/model                                   listModels()
 *   POST /session {directory?}                        createSession()
 *   POST /session/{id}/init                           initSession()
 *   POST /session/{id}/prompt {providerID, modelID, prompt, messageID?} prompt()
 *   POST /session/{id}/abort                           abortSession()
 *   GET  /session/{id}                                 getSession()
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
 *  - The /api/* "v2" variants (prompt_async, SessionV2Info, PromptInput) mirror
 *    the same concepts but use different request shapes; this client targets
 *    the documented + verified non-v2 set above which the plan pins.
 */

import type {
  SessionInfo,
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
  messageID?: string;
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
      try {
        const text = await res.text();
        detail = text.slice(0, 300);
      } catch {
        /* ignore body read error */
      }
      throw new OpencodeError(`OpenCode ${method} ${path} failed (${res.status}): ${detail}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      return undefined as T;
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
    const body = await this.request<{ id: string }>(
      "POST",
      "/session",
      directory !== undefined ? { directory } : {},
    );
    if (!body?.id) throw new OpencodeError("OpenCode createSession returned no id");
    return body;
  }

  async initSession(id: string, opts?: { modelID?: string; providerID?: string }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (opts?.modelID) body.modelID = opts.modelID;
    if (opts?.providerID) body.providerID = opts.providerID;
    await this.request<unknown>("POST", `/session/${encodeURIComponent(id)}/init`, body);
  }

  async prompt(id: string, opts: PromptOptions): Promise<{ id?: string } | null> {
    const body: Record<string, unknown> = { providerID: opts.providerID, modelID: opts.modelID, prompt: opts.prompt };
    if (opts.messageID) body.messageID = opts.messageID;
    const result = await this.request<Record<string, unknown> | { data?: Record<string, unknown> }>(
      "POST",
      `/session/${encodeURIComponent(id)}/prompt`,
      body,
    );
    return null;
  }

  async abortSession(id: string): Promise<void> {
    await this.request<unknown>("POST", `/session/${encodeURIComponent(id)}/abort`, {});
  }

  async getSession(id: string): Promise<SessionInfo> {
    const body = await this.request<Record<string, unknown>>("GET", `/session/${encodeURIComponent(id)}`);
    return normalizeSessionInfo(body);
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

  async replyQuestion(
    requestID: string,
    req: { answers: Array<{ questionID?: string; selected: string[] }> },
  ): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/question/${encodeURIComponent(requestID)}/reply`,
      req,
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
  };
}
