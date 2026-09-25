# Phase 5 — Ollama-Native Agent Runtime & Advanced Execution — Implementation Plan

**Date:** 2026-09-24
**Baseline:** HEAD `be3841e` ("Pin the High Lord castle to the city centre on the map"), Phases 1–4 complete. Migration head `0003_smooth_doctor_doom`. Working tree clean.
**Author:** planning agent (no production code written)
**Source of truth for scope:** `docs/IMPLEMENTATION_PLAN.md` §9 (lines ~345–366).

---

## 0. Codebase verification findings (read before implementing)

Everything below was verified against the code, not the docs. Doc claims that did NOT
match code are flagged. These findings drive the plan.

### 0.1 Confirmed facts (answers to the required verification questions)

| Question | Answer (verified) |
|---|---|
| **Does a provider interface already exist?** | **YES.** `src/server/execution/types.ts` already defines `AgentExecutionProvider` with `startTask / sendMessage / cancelTask / getStatus / respondToApproval / getDiff / listModels / health`, and `createOpenCodeAdapter()` in `src/server/execution/opencode/provider.ts` already implements it. **Phase 5 does NOT need to extract an interface from scratch.** The real gap is that the *engine seam* (queue + runner) is hard-wired to OpenCode (see 0.2.1). |
| `executionProvider` storage | **Not on `houses`.** It lives on `agent_configurations.execution_provider` (CHECK `in ('opencode','ollama')`), surfaced as `HouseDto.configuration.executionProvider`. `houses` has only `kind` (agent/high_lord) + `status`. |
| `execution_sessions.provider` | Column exists, CHECK `in ('opencode','ollama')`, default `'opencode'`. **No schema change needed** to start writing Ollama sessions. |
| `agent_messages` shape | Exists: `id, session_id, role, content, relayed_at, provider_message_id, created_at`. **Role CHECK is `role in ('user','agent')` only** — no `tool`/`system` role, no `tool_calls`/`tool_call_id` columns. This is a Phase-5 gap for tool-loop memory (see 0.2.5). |
| `usage_records.estimated` | **Already exists**: `estimated integer(boolean) not null default false`. The `estimated=true` plumbing is already present; the delta is aggregation/labelling + the Ollama runtime passing `estimated: true`. |
| Pricing-table home | `provider_configs.extra` JSON column exists and is the documented home (`extra.modelPricing`). No code reads it for pricing yet. **No schema change needed.** |
| `execution_events` types | The CHECK already contains every type the Ollama loop needs: `task_started, session_started, message, tool_call, tool_result, approval_requested, approval_resolved, task_completed, task_failed, error, usage, session_aborted, unknown`. **No new event type / CHECK migration needed** (same "reuse the event model" discipline as Phase 4). |
| Status enums | `TASK_STATUSES` / `SESSION_STATUSES` in `src/shared/constants.ts` mirror the CHECKs in `schema.ts`. **Neither contains `paused`.** `HouseRuntimeStatus` has no `paused`; `CityVisualState` (map) has no `paused`. Native pause needs a persisted representation (decision-gated — §Open Questions Q3). |
| Path safety | `resolveSafePath(candidate, allowlist)` / `isPathAllowed` in `src/lib/paths.ts` — realpath + prefix containment, throws on escape/empty allowlist. Queue calls it in `resolveWorkspace` (`src/engine/queue.ts:204`). Tool executors MUST call it. |
| Queue health gate | `TaskQueue.processOnce()` (`src/engine/queue.ts:80-88`) gates **all** task claiming on `this.deps.client.health()` (OpenCode). An Ollama house task would be blocked whenever OpenCode is down, and would then run through the OpenCode runner/SSE. This is the biggest seam defect for Phase 5. |
| Provider selection | None. `runClaimedTask` always calls `executeTask()` (OpenCode runner). Only `house.kind === 'high_lord'` branches (to `runParent`). There is no `executionProvider` branch. |
| Model picker | `GET /api/models` → `listModels(client, providerId)` (`src/server/services/model-service.ts`) proxies **OpenCode only** and filters by `providerId`. House form calls `/api/models?providerId=opencode` and falls back to free text. No Ollama model source. |
| E2E isolation | Playwright `webServer` deletes `db/velaris-e2e.db` and boots `dev:web` with `VELARIS_DB_PATH` override; engine is **never** started. Execution rows are seeded directly via `better-sqlite3` (`tests/e2e/phase4-court.spec.ts` `openDb()`), and OpenCode/Ollama HTTP is never touched. |
| Unit/integration isolation | `tests/unit/runner-status-machine.test.ts` + `tests/unit/opencode-client.test.ts` establish the mocking conventions: real temp DB + `migrate()`, `resetDbForTests()` per test, injected `fetchImpl` (no network), `vi.mock("@/server/execution/runner")` for queue tests. |
| Ollama client | **There is no Ollama client/adapter anywhere.** `src/server/execution/ollama/` does not exist. Only constants (`DEFAULT_PROVIDER_BASE_URLS.ollama = "http://localhost:11434"`), the seeded provider config, and `OLLAMA_BASE_URL` in `.env.example`/`.env.local` exist. |
| `OLLAMA_BASE_URL` | Present in `.env.example:14` and `.env.local`. Not read anywhere in `src/`. The OpenCode resolver (`resolveBaseUrl`) reads `process.env.OPENCODE_BASE_URL` first. |
| `supportsNativePause` | Does not exist. Must be added as a new capability flag. |
| Engine single-writer | Confirmed. `runner.ts` header + `execution-repo.ts` header: engine is single writer for sessions/events/messages/artifacts/usage and approval *creation*; web writes only approval responses + notification read state (+ the cancel cascade). The Ollama loop must run in the engine. |

### 0.2 Contradictions / gotchas found (docs vs code)

1. **The engine is OpenCode-coupled even though the adapter interface is generic.**
   `RunContext.client: OpencodeClient` (`runner.ts:50`), `QueueDeps.client: OpencodeClient`
   (`queue.ts:34`) and `OrchestratorDeps.client: OpencodeClient` (`orchestrator.ts:93`) are
   concrete classes. The queue health-gates globally on OpenCode. **This is the prerequisite
   work — not interface extraction, but seam decoupling.** Any change here risks the
   OpenCode path; it must be additive and regression-tested.
2. **`AGENT_ORCHESTRATION.md` §2 points at `src/engine/adapters/types.ts`**, which does not
   exist; the real interface is `src/server/execution/types.ts`. The doc's pseudo-interface
   also includes `getEvents(directories)` which the real interface deliberately does **not**
   (the OpenCode client's `subscribeEvents` is used directly by the runner). Docs lag; code wins.
3. **`AGENT_ORCHESTRATION.md` §3 event table uses names that do not exist in code**
   (`message_part`, `permission_request`, `status_change`, `usage_update`, `completion`,
   `blocked`, `waiting_*`). The real `ExecutionEventType` union is
   `message / tool_call / tool_result / approval_requested / approval_resolved / usage /
   task_completed / task_failed / session_aborted / …`. Plan against the code's names.
4. **`AGENT_ORCHESTRATION.md` §1 says "poll queue (1s)"; code polls every 2s**
   (`queue.ts:66`). Phase 5 timing references use 2s.
5. **`ARCHITECTURE.md` §6.2 claims `agent_messages.role` is `('user'|'assistant'|'tool')`;
   code is `('user'|'agent')`.** The migration in Stage C reconciles this (adds `tool`),
   keeping `agent` for the OpenCode path.
6. **`AGENT_ORCHESTRATION.md` §8 shows `POST /v1/chat`; `IMPLEMENTATION_PLAN §9` says
   "Ollama HTTP API".** No API surface is actually decided. Recommendation: native `/api/chat`
   (Open Question Q1).
7. **`AGENT_ORCHESTRATION.md` §1 says "ensure OpenCode server … spawn if needed" and §2.1
   says "queue serializes per working directory by default".** Code reality: the queue
   serializes per **house** (`houseBusy` Set + `getActiveSessionForHouse`), and the
   orchestrator adds DAG-level per-directory serialization for High Lord children. There is
   no global per-directory queue serialization. The Ollama runtime inherits the per-house
   rule (concurrency=1) — do not assume directory serialization exists.
8. **`/experimental/worktree` is an OpenCode server endpoint**, not an Ollama one, and the
   `OpencodeClient` has no method for it. Phase 5's "worktree exploration" is therefore
   OpenCode-scoped and orthogonal to the Ollama runtime (Open Question Q7).
9. **`execution_preferences.plan.*` is engine-owned and clobber-guarded** on plan-linked
   tasks (`api/tasks/[id]/route.ts:43-52`, `task-repo.ts:111-137`). If pause state is stored
   in prefs it will collide with that guard; prefer a status (Open Question Q3).

---

## 1. Objective

Make `executionProvider='ollama'` houses first-class Velaris agents. Velaris itself becomes
the agent runtime: a tool loop (model call → tool_use → permission-gated execute →
tool_result → repeat) drives a direct Ollama HTTP endpoint, with conversation memory
persisted in `agent_messages`, a per-session task state machine, **native pause/resume**
(which OpenCode cannot offer), estimated cost rows flagged `estimated=true`, and a
flag-gated (default-off) exploration of OpenCode `/experimental/worktree` isolation.

The loop runs in the **engine** (single writer for execution tables). It reuses the
existing `AgentExecutionProvider` interface, the existing `execution_events` type set, the
existing approval/notification rows, `resolveSafePath`, and the existing usage tables. It
does **not** fork the OpenCode path.

**Out of scope:** multi-agent houses (Phase 6), usage dashboards (Phase 6, but the
`estimated` label surfaces now), Archives (Phase 6), OpenCode-side behavior changes,
dependency additions, Ollama Cloud (that stays via OpenCode's `ollama-cloud` provider),
`/vcs` operations, cloud/remote model auth.

**Non-goals that must not regress:** direct-to-house OpenCode execution, High Lord
orchestration + steering, approvals round-trip, the 9-section UI and its e2e empty-state
assertions, and the "engine single-writer / web read-only" contract.

---

## 2. Codebase verification summary — what changes vs. what already suffices

### 2.1 Tables that ALREADY suffice (no migration)

| Table | Why it's enough |
|---|---|
| `houses` | Provider lives on config; `kind`/`status` unchanged. |
| `agent_configurations` | CHECK already allows `execution_provider='ollama'`. |
| `execution_sessions` | `provider` CHECK already allows `'ollama'`; cost/token columns exist. *(status CHECK may need `paused` — Q3.)* |
| `execution_events` | All needed type values already in the CHECK. |
| `approval_requests` | Reusable for tool gating; `provider_request_id` is UNIQUE → use synthetic `ollama:<sessionId>:<toolCallId>`. |
| `notifications` | Reusable (`type in ('approval','completion','failure','system')`). |
| `usage_records` | `estimated` boolean already exists. |
| `provider_configs` | `extra` JSON is the pricing + settings home. |
| `subtasks` / `handoffs` | Unaffected. |
| `artifacts` | `kind in ('diff','file_list','result','other')` — Ollama uses `result`/`file_list`. |

### 2.2 Tables needing change (migration `0004_*`)

| Table | Change | Rationale |
|---|---|---|
| `agent_messages` | `+ tool_calls TEXT DEFAULT '[]'`, `+ tool_call_id TEXT`, role CHECK `in ('user','agent','tool')` | Tool-loop memory must be reconstructible for native pause/resume and crash recovery. Assistant turns carry `tool_calls`; tool results are `role='tool'` with `tool_call_id`. Additive: OpenCode writes only `user`/`agent` and ignores the new columns. |
| `execution_sessions` | status CHECK `+ 'paused'` **(decision-gated Q3)** | Native pause is a real persisted session state. |
| `tasks` | status CHECK `+ 'paused'` **(decision-gated Q3, recommended)** | So the UI/Quest Board can show a paused quest honestly. |

No event-type migration; no new tables are strictly required. If Q3 is answered "use a
boolean instead", only the `agent_messages` half of `0004` remains.

### 2.3 Files that already implement part of a deliverable (scope the delta)

| Deliverable | Already present | Delta |
|---|---|---|
| Provider interface | `AgentExecutionProvider` + OpenCode impl | Add capability flags + engine seam (Stage A). |
| `executionProvider` UI selection | House form Execution tab `Select` over `EXECUTION_PROVIDERS` | Add Ollama helper text + health/model hints (Stage J). |
| `estimated` plumbing | `usage_records.estimated` + `createUsageRecord({estimated})` | Aggregate + surface (Stage H). |
| Approval pipeline | rows + respond route + notifications + runner relay | Reuse; add synthetic-provider gating in the loop (Stage E). |
| Path safety | `resolveSafePath` / `isPathAllowed` | Call from tool executors (Stage D). |
| Config/env | `.env.example` `OLLAMA_BASE_URL`, seeded "Ollama (local)" config | Read it; prefer default Ollama provider config base_url (Stage B). |

---

## 3. Deliverables — numbered stages

Ordered so the build is always green: Stage A introduces no runtime behavior change;
Stages B–C are inert additions; D–F add the runtime behind the provider branch; G–J layer
on capabilities and UI.

| Stage | Title | One-line deliverable | Size |
|---|---|---|---|
| A | Provider seam & capability flags | Make the engine provider-agnostic (selection + per-provider health) without changing OpenCode behavior | M |
| B | Ollama HTTP client + health | New `OllamaClient` (fetch-based) with health, chat, tags/models | S |
| C | Schema migration `0004` | `agent_messages` tool columns/role; `paused` statuses (Q3) | M |
| D | Tool registry & tool set | Zod-validated tools (fs read/write, shell, web-fetch-off) enforcing the allowlist | M |
| E | Permission gating | Pure gate + approval/notification reuse for risky tool calls | M |
| F | Tool loop runtime + memory + state machine | The engine's Ollama agent loop, persisted memory, session state machine | L |
| G | Native pause/resume | Loop suspends between steps and resumes in place from persisted memory | M |
| H | Cost estimation | Pricing table + `estimated=true` rows + aggregation/labels | S |
| I | Worktree exploration (flag-gated, default off) | OpenCode-only experimental isolation behind a settings flag | S |
| J | UI surface | Ollama selection hints, paused badges, estimated labels, pricing editor | M |

---

## 4. Stage A — Provider seam & capability flags (M)

**Goal:** the queue/runtime chooses the provider implementation per house and health-gates
each provider independently, with **zero** behavior change for OpenCode houses.

### A.1 Interface additions (additive, non-breaking)

`src/server/execution/types.ts`:

```ts
export type ProviderKind = "opencode" | "ollama";

export interface AgentExecutionProvider {
  /** Discriminator for runtime dispatch + health gating. */
  readonly kind: ProviderKind;
  /** True when the provider can truly suspend a running loop in place (Phase 5 Ollama). */
  readonly supportsNativePause: boolean;
  startTask(...): ...;
  // ... existing methods unchanged
}
```

`src/server/execution/opencode/provider.ts`: set `kind: "opencode"`,
`supportsNativePause: false`. No method body changes. (Existing tests that cast
`AgentExecutionProvider` — `queue-loop.test.ts:110`, `runner-status-machine.test.ts:90` —
may need the two new fields added to their fakes; keep fakes complete to avoid type errors.)

### A.2 Provider factory (engine)

New `src/engine/provider-factory.ts`:

- `resolveProviderKind(house): ProviderKind` → `house.configuration.executionProvider`.
- `createProviderForHouse(kind, deps): AgentExecutionProvider` → OpenCode adapter today,
  Ollama adapter after Stage F.
- `providerHealth(kind, deps): Promise<boolean>` → OpenCode `client.health()`; Ollama
  `ollamaClient.health()` (Stage B). A per-tick cache avoids N health probes per pass.

### A.3 Queue seam

`src/engine/queue.ts`:

- Replace the unconditional global health gate (`processOnce` lines 80-88) with a
  **per-task provider health gate before claim**: for each queued task, load its house's
  provider kind, consult the tick health cache, and skip (leave `queued`) when unhealthy.
  This preserves the existing regression (`tests/unit/queue-loop.test.ts` health-gate test:
  the task stays `queued`) while allowing Ollama tasks through when only OpenCode is down.
- In `runClaimedTask`, after the `house.kind === "high_lord"` branch, branch on
  `house.configuration.executionProvider`:
  - `"opencode"` → existing `resolveWorkspace` + `executeTask` (unchanged);
  - `"ollama"` → `resolveWorkspace` (still required) + `runOllamaTask` (Stage F).
- `QueueDeps` gains an optional `ollama?: OllamaClient` (Stage B) and keeps `client`.

**Regression risk (explicit):** moving the health gate changes control flow. Mitigation:
extract a `getProviderHealth(kind)` helper that returns the same result the old gate did
for OpenCode, add a unit test asserting the OpenCode health-gate behavior is byte-for-byte
preserved (task stays `queued`), and run the full `queue-loop` + `queue-highlord` suites.

### A.4 Tests

- `tests/unit/provider-seam.test.ts` (new): OpenCode adapter has `kind="opencode"` /
  `supportsNativePause=false`; factory picks the right kind; health gate leaves an
  OpenCode task queued when OpenCode is unhealthy and lets an Ollama task through when
  only OpenCode is down (using fakes).
- Extend `tests/unit/queue-loop.test.ts`: unchanged OpenCode health-gate expectations.

---

## 5. Stage B — Ollama HTTP client + health (S)

**Goal:** a typed, dependency-free HTTP client mirroring `src/server/opencode/client.ts`.

New `src/server/execution/ollama/client.ts`:

```ts
export class OllamaError extends Error { status: number; }
export function resolveOllamaBaseUrl(fallbackDefault?: string): string {
  return (process.env.OLLAMA_BASE_URL ?? fallbackDefault ?? "http://localhost:11434")
    .replace(/\/+$/, "");
}
export interface OllamaClientOptions {
  baseUrl?: string; signal?: AbortSignal; fetchImpl?: typeof fetch;
}
export class OllamaClient {
  health(): Promise<boolean>;              // GET /api/version  (200 → true; any error → false)
  listModels(): Promise<string[]>;         // GET /api/tags → models[].name
  chat(req: OllamaChatRequest): Promise<OllamaChatResponse>; // POST /api/chat, stream:false
}
```

Types (same file or `src/server/execution/ollama/types.ts`):
`OllamaChatMessage = { role: 'system'|'user'|'assistant'|'tool'; content: string; images?: string[]; tool_calls?: OllamaToolCall[]; tool_name?: string }`,
`OllamaToolCall = { function: { name: string; arguments: Record<string, unknown> } }`,
`OllamaToolDef = { type:'function'; function:{ name; description; parameters: JSONSchema } }`,
`OllamaChatResponse = { message: OllamaChatMessage; prompt_eval_count?: number; eval_count?: number; done: boolean; error?: string }`.

**Why raw `fetch`, not an npm client:** AGENTS.md forbids unprompted dep bumps; the Ollama
HTTP API is a 3-endpoint surface; `OpencodeClient` already establishes the injected-`fetchImpl`
+ injectable-baseUrl test convention. Zero new deps.

**Base URL precedence:** default Ollama provider config (`provider_configs.type='ollama'
AND is_default=1`) `.base_url` → `OLLAMA_BASE_URL` env → `DEFAULT_PROVIDER_BASE_URLS.ollama`.
(OpenCode resolves env-first; for Ollama the per-config URL is more useful since Settings
edits it. State this preference in a comment.) A small engine helper reads the config once.

### B.1 Tests

`tests/unit/ollama-client.test.ts` (new, injected `fetchImpl`, no network):
- `resolveOllamaBaseUrl` env precedence + trailing-slash strip.
- `health()` true/false on 200/error.
- `listModels()` parses `{models:[{name}]}`, tolerates unknown shape.
- `chat()` posts `{model, messages, tools, stream:false}` and parses `message.tool_calls`,
  `prompt_eval_count`, `eval_count`; throws `OllamaError` on non-2xx; tolerates `error` in body.

---

## 6. Stage C — Schema migration `0004` (M)

**Goal:** persist tool-loop memory and (recommended) a real `paused` state, additively.

### C.1 `src/lib/db/schema.ts`

```ts
// agent_messages additions
toolCalls: text("tool_calls").notNull().default("[]"), // JSON OllamaToolCall[]
toolCallId: text("tool_call_id"),                       // links a role='tool' result
// role CHECK becomes:
check("ck_agent_messages_role", sql`role in ('user','agent','tool')`)

// paused (Q3, recommended)
// execution_sessions status CHECK: add 'paused'
// tasks status CHECK: add 'paused'
```

Export row types unchanged (`AgentMessageRow`/`New` pick the columns up automatically).

### C.2 Constants/types parity (same commit — AGENTS.md)

`src/shared/constants.ts`: add `'paused'` to `TASK_STATUSES` and `SESSION_STATUSES` (Q3).
`src/shared/types.ts`: add `'paused'` to `TaskStatus` and `SessionStatus`.

**Ripple (TypeScript will force every one of these):** `task-status-badge.tsx` Record,
`runtime-status-badge.tsx` Record (+ `HouseRuntimeStatus` if we surface paused there),
`map/animation-map.ts` `statusToVisualState`/`CityVisualState`, `listInFlightTaskIds`
(`task-repo.ts:253`) must include `paused` as in-flight, `isTerminalStatus`
(`task-status-badge.tsx`) must **exclude** paused, `deriveRuntimeStatus`
(`execution-service.ts`) needs a `paused` case. Enumerate these in the migration commit; a
missed switch is a compile error, not silent drift (good).

### C.3 Migration workflow

1. Edit `schema.ts`.
2. `npm run db:generate` → `drizzle/0004_*.sql` + `drizzle/meta/*` — **commit**.
3. Update `constants.ts` + `types.ts` in the same commit.
4. No manual `db:migrate` needed (boot self-migrates web + engine; test `migrate()` picks it up).

### C.4 Risk

SQLite cannot `ALTER … CHECK`; drizzle-kit emits a table rebuild for
`agent_messages`/`tasks`/`execution_sessions`. There is **no precedent for a CHECK alter**
in this repo (0000–0003 are additive). Verify the generated SQL preserves indexes/FKs and
that `migrate()` succeeds against a copy of `db/velaris.db` before committing. If the
rebuild proves fragile, fall back to Q3's boolean option for pause and keep only the
`agent_messages` rebuild.

### C.5 Tests

- `tests/unit/schemas.test.ts` (extend): `TASK_STATUSES`/`SESSION_STATUSES` contain `paused`
  (conditional on Q3); `AGENT_MESSAGE_ROLES` includes `tool`.
- `tests/unit/repositories.test.ts` (extend): `upsertAgentMessage` with `role: 'tool'` +
  `toolCallId` round-trips; unknown role rejected by CHECK.
- Migration smoke is covered by every temp-DB test calling `migrate()`.

---

## 7. Stage D — Tool registry & tool set (M)

**Goal:** a declarative tool registry where each tool declares a zod input schema, a
permission class, and an executor that enforces the allowlist.

New `src/server/execution/ollama/tools/`:

| File | Responsibility |
|---|---|
| `types.ts` | `OllamaTool` = `{ name; description; parameters: JSONSchema; permissionClass: 'fs_read'|'fs_write'|'shell'|'network'; execute(input, ctx): Promise<ToolResult> }`; `ToolContext = { workingDirectory; allowlist; }`; `ToolResult = { ok; output; error?; filesTouched?: string[] }`. |
| `registry.ts` | `buildToolRegistry(config): OllamaTool[]` selected from `agent_configurations.tools` (`["fs","shell","git"]`) + permission config. `toOllamaToolDefs(tools)` for the `/api/chat` `tools` array. |
| `fs.ts` | `fs_read(path)`, `fs_list(path)`, `fs_write(path, content)`. Every path through `resolveSafePath(path, allowlist)`; `fs_write` additionally requires the resolved path (realpath of the parent for new files) inside the allowlist. Out-of-allowlist → gate (Stage E), not silent refusal. |
| `shell.ts` | `shell_exec(command, cwd?)`: `cwd` validated via `resolveSafePath`; executes via `node:child_process` `execFile`/`spawn` with a timeout; captures stdout/stderr/exit code. Never a shell-string interpolation API; return structured result. |
| `web-fetch.ts` | `web_fetch(url)`: **off by default** — only registered when `permissions.network === 'allow'` or the tool is explicitly enabled; otherwise the tool is absent from the definitions so the model cannot call it. |
| `git.ts` (optional) | Thin `git status`/`diff` wrapper if `"git"` is in tools; read-only. |

Design rules:
- **Allowlist is defensive at execution.** Even if the model asks for an unsafe path, the
  executor re-resolves and the gate (Stage E) decides — never trust the model.
- **No `web_fetch` default.** `permissions.network` defaults to `deny`; the tool stays out
  of the registry unless explicitly enabled (Open Question Q6).
- **Tool result normalization** to a string for `agent_messages.content` + a summary for
  `execution_events.tool_result`.

### D.1 Tests

- `tests/unit/ollama-tools.test.ts` (new): registry selection by config; `fs_read` inside
  allowlist succeeds; `fs_read`/`fs_write` outside allowlist is flagged for gating (not
  executed); `fs_write` inside allowlist writes a temp file; `shell_exec` runs `true`/`echo`
  and returns exit code; `shell_exec` with a cwd outside allowlist is refused; network tool
  absent by default. Use temp dirs + `resolveSafePath` real paths.

---

## 8. Stage E — Permission gating (M)

**Goal:** map tool permission classes + house permission modes + approval policy into
allow / execute / ask-user, reusing `approval_requests` + `notifications`.

New pure `src/server/execution/ollama/tools/permissions.ts`:

```ts
export type GateDecision = { action: "execute" } | { action: "deny"; reason: string }
  | { action: "ask"; kind: "permission"; title: string; message: string };

export function gateToolCall(args: {
  tool: OllamaTool;
  permissions: Permissions;         // {fileSystem, shell, network, git}
  approvalPolicy: ApprovalPolicy;
  pathInsideAllowlist: boolean;     // precomputed per call
}): GateDecision;
```

Mapping (mirrors AGENT_ORCHESTRATION §9.3, keeps `risky_only` = `always` as the
OpenCode path already documents, `runner.ts:481`):

| Class | Mode | Decision |
|---|---|---|
| `fs_read` | in allowlist | execute |
| `fs_read`/`fs_write` | out of allowlist | **always ask** (safety override even under `never`) |
| `fs_write` | in allowlist | mode `allow` → execute; `ask` → ask; `deny` → deny |
| `shell` | — | `allow` → execute; `ask` → ask; `deny` → deny |
| `network` | — | `allow` → execute; `ask` → ask; `deny` → deny (default) |

Approval creation (engine writer, reuse repos):
- `createApprovalRequest(db, { sessionId, taskId, houseId, providerRequestId:
  \`ollama:${sessionId}:${toolCallId}\`, kind: 'permission', title, message, options: [] })`.
  The synthetic id keeps the UNIQUE index and dedupes on retry/crash.
- `createNotification({ type:'approval', … })` (bird lands in the Roost unchanged).
- Emit `execution_events { type:'approval_requested' }`.
- The runtime then **polls the DB** (not the provider) for the reply:
  `listRespondedApprovalsForSession(db, sessionId)` → execute or deny the tool, append a
  `tool_result`, and continue. This is the exact pattern the OpenCode runner uses
  (`runner.ts:254`), so the respond route + Roost need **no changes**.
- On approve, emit `approval_resolved` and `markApprovalRelayed` (so the row is not
  re-processed). On deny, feed a tool_result describing the denial back to the model.
- `adapter.respondToApproval` for Ollama is a **documented no-op** (the loop owns gating in
  the DB). Do not route Ollama approvals through the OpenCode relay.

### E.1 Tests

- `tests/unit/ollama-permissions.test.ts` (new): the full matrix above, including
  out-of-allowlist under `approval_policy='never'` still asking; `network` deny default;
  `risky_only` behaving as `always` (parity with runner).
- `tests/unit/ollama-approval.test.ts` (new, DB-backed): gate ask → approval row +
  notification; `setApprovalResponse(approved)` → loop executes; `rejected` → tool_result
  denial; synthetic provider_request_id dedupe on retry.

---

## 9. Stage F — Tool loop runtime + conversation memory + state machine (L)

**Goal:** the engine-side loop and its persisted memory. This is the core.

New `src/server/execution/ollama/runtime.ts` — `runOllamaTask(ctx, opts): Promise<RunResult>`
with the same `RunResult` contract as `executeTask` so the queue treats both identically.

### F.1 Control flow

1. **Persist session first** (crash-recoverable): `createExecutionSession({ provider:'ollama',
   modelId, directory })`; emit `task_started`; `setTaskStatus(running)`.
2. **Subscribe to a control signal**: the runtime owns no provider SSE. Instead it polls
   between steps for external intents: pause (Stage G), cancel (task/session status),
   user messages (`findPendingUserMessage`), and approval replies. Poll interval reuses the
   runner's `pollMs` convention (default 1500ms).
3. **Loop:** while not terminal:
   - a. **Build messages** (memory): system prompt (house) + task brief + persisted turns.
     `buildOllamaMessages(db, sessionId, systemPrompt, taskPrompt)` in
     `src/server/execution/ollama/memory.ts` reads `agent_messages` ordered by `created_at`,
     maps `role 'user'→'user'`, `'agent'`→`'assistant'`, `'tool'`→`'tool'`, and re-attaches
     `tool_calls` from the stored JSON. **Trim to a context budget** (token-ish char cap,
     keep system + most recent turns; never split an assistant tool_call from its results).
   - b. **Pause checkpoint** (Stage G): if a pause intent is set → persist paused, return
     without a terminal (the queue releases the house; resume re-enters).
   - c. **Model call:** `ollama.chat({ model, messages, tools: toolDefs, stream: false })`.
     Emit `message` events for assistant text; persist an `agent_messages` row
     (`role:'agent'`, `content`, `tool_calls` JSON).
   - d. **If `message.tool_calls`:** for each call — validate arguments against the tool's
     zod schema; compute `pathInsideAllowlist`; `gateToolCall`; if execute → run executor,
     persist `role:'tool'` + `tool_call_id` + result; if ask → create approval, emit event,
     **wait** (poll) for the reply, then execute/deny; if deny → persist denial tool_result.
     Emit `tool_call` / `tool_result` execution_events (existing types). Continue the loop.
   - e. **Else (no tool calls):** final answer → persist result artifact (`kind:'result'`),
     optional `file_list` artifact from `filesTouched`, terminal `completed`.
   - f. **Usage per model call:** accumulate `prompt_eval_count`/`eval_count`; persist a
     `usage` event and (Stage H) a usage row.
4. **Terminal persistence:** mirror `persistTerminal` semantics — session status, task
   status, notifications (`completion`/`failure`), `task_completed`/`task_failed` events.
   Reuse the repo calls (do **not** import the OpenCode runner's internals; factor the
   shared terminal logic only if it stays behavior-identical).

### F.2 Ollama adapter

New `src/server/execution/ollama/provider.ts` implementing `AgentExecutionProvider` with
`kind:'ollama'`, `supportsNativePause:true`:
- `startTask`: no-op handshake — the runtime owns the loop; returns `{ providerSessionId:
  sessionId }` (Ollama is stateless, so the Velaris session id is the provider handle).
- `sendMessage`: append a `user` agent_message (or in-memory) and signal the loop to
  continue. Used by chat/steer.
- `cancelTask`: set a cancel marker (the loop observes the task/session row).
- `getStatus`: derive from the session row (running/paused/completed/…).
- `respondToApproval`: no-op (documented; gating is DB-polled).
- `getDiff`: returns `[]` (Ollama produces no provider diff) — the runtime emits a
  `file_list` artifact instead.
- `listModels`: `OllamaClient.listModels()`.
- `health`: `OllamaClient.health()`.

### F.3 Per-agent task state machine

Persist transitions on `execution_sessions`/`tasks` mirroring AGENT_ORCHESTRATION §4:
`pending → running → (awaiting_approval | awaiting_input) → running → completed|failed|aborted`
plus `paused ⇄ running` (Q3). Emit `session_started`, `approval_requested/resolved`,
`message`, `tool_call`, `tool_result`, `task_completed/failed`, `session_aborted`. **No new
event types.** The derived `HouseRuntimeStatus` follows via `deriveRuntimeStatus`.

### F.4 Engine wiring

- `src/engine/main.ts`: construct an `OllamaClient` from the default Ollama provider config,
  pass it + the factory into `TaskQueue`.
- `src/engine/queue.ts`: the `ollama` branch calls `runOllamaTask` with a `RunContext`-like
  object (reuse `RunContext` where possible; if `client: OpencodeClient` is required, add an
  optional `ollamaClient` field rather than removing `client`).
- `src/engine/reconcile.ts`: add an Ollama pass — sessions left `running`/`paused` with no
  live engine get `interrupted` and their task requeued (the generic pass mostly covers
  this; verify `getActiveSessionForHouse` and `listInFlightTaskIds` include `paused`).

### F.5 Tests

- `tests/unit/ollama-runtime.test.ts` (new, DB-backed like `runner-status-machine.test.ts`):
  mocked `OllamaClient.chat` scripts a fixed sequence:
  1. tool_call `fs_read` inside allowlist → executes → next call final text → `completed`;
     assert `execution_events` types, `agent_messages` (user/agent/tool) order, result artifact.
  2. multi-tool turn (two calls) → both results persisted with distinct `tool_call_id`.
  3. out-of-allowlist write → approval row + notification → session `awaiting_approval`;
     approve → executes → continues; reject → denial tool_result → continues.
  4. malformed tool arguments → tool_result error, loop continues (never throws).
  5. chat HTTP failure → terminal `failed` + failure notification.
  6. task cancelled mid-loop → `aborted`, `session_aborted`, provider calls stop.
  7. memory trim: >N turns → oldest dropped, tool_call/result pairs kept together.
- `tests/unit/ollama-memory.test.ts` (new): message reconstruction + trimming (pure given
  a seeded DB).
- `tests/unit/queue-ollama.test.ts` (new): an Ollama house task routes to `runOllamaTask`
  (mocked) and does **not** call `executeTask`; OpenCode house still calls `executeTask`.

---

## 10. Stage G — Native pause/resume (M)

**Goal:** pausing genuinely stops the loop between steps; resuming continues in place from
persisted memory. Honest contrast with OpenCode documented in the UI.

### G.1 API routes (web writes intent; engine observes)

Decision-gated representation (Q3). Recommended (status-based):
- `POST /api/tasks/[id]/pause` → 404 unknown; **409** if the house's
  `executionProvider !== 'ollama'` ("This provider cannot pause — cancel instead") or if
  `!provider.supportsNativePause`; 409 if terminal; else set session + task `paused`
  (web write analogous to the cancel route's session abort) + a `message` event
  `{ pause: true }` so the UI reacts immediately. Return `{ task }`.
- `POST /api/tasks/[id]/resume` → 404/409 (not paused / non-Ollama); set session + task
  `running` + event `{ pause: false }`. The engine loop, on its next checkpoint, rebuilds
  messages from memory and continues.
- Reuse `src/server/api-helpers.ts` (`ok/notFound/conflict/badRequest`).

If Q3 chooses the boolean option: routes set `execution_preferences.ollama.paused` via a
dedicated engine-owned writer (extend `writeTaskPlanAbortReason`-style merge helper), and
the task stays `running`; still 409 the OpenCode case.

### G.2 Loop mechanics

- Pause is checked at the **top of each loop iteration** (before the model call) and
  immediately after a tool execution completes. In-flight HTTP calls are not interrupted;
  we only guarantee no *new* call starts. State is durable because every turn is persisted
  before the next call.
- The queue's `houseBusy` set is released when `runOllamaTask` returns on pause, so other
  tasks for the house can run; on resume the task is re-queued (or the resume route sets it
  `queued` and the queue claims it). **Recommendation:** resume sets task `queued`; the
  engine re-claims and `runOllamaTask` detects an existing non-terminal session with memory
  and continues it instead of starting fresh. This reuses the crash-recovery discipline.
- **No provider-side state:** "native" here means the Velaris loop can suspend exactly and
  resume deterministically from DB memory, because Ollama is a stateless request/response
  API — unlike OpenCode whose loop lives server-side and can only be aborted.

### G.3 Tests

- `tests/unit/ollama-pause.test.ts` (new, DB-backed): pause intent set before the 2nd chat
  call → loop returns paused, no 2nd call; resume → next chat call includes the full prior
  memory (assert the mocked request messages); pause during a pending approval → stays
  paused, approval survives; `supportsNativePause` true for the Ollama adapter / false for
  OpenCode.
- `tests/integration/ollama-pause-routes.test.ts` (new, temp-DB contract): pause 200 on an
  Ollama task, 409 on an OpenCode task, 409 terminal, 404 unknown; resume symmetry.

---

## 11. Stage H — Cost estimation (S)

**Goal:** every Ollama usage row is flagged `estimated=true`, priced from a settings-managed
table, and the UI distinguishes estimates.

### H.1 Pricing

New pure `src/server/execution/ollama/pricing.ts`:

```ts
export interface ModelPricing { inputPer1M: number; outputPer1M: number; }
export function parsePricing(extra: Record<string, unknown>): Record<string, ModelPricing>; // reads extra.modelPricing
export function estimateCost(modelId, tokens: {input:number; output:number}, pricing): number;
```

- Source of truth: the default Ollama `provider_configs` row's `extra.modelPricing` (matches
  AGENT_ORCHESTRATION §7 exactly). **No hardcoded model names.**
- Runtime: after each chat call, accumulate tokens; at terminal write
  `createUsageRecord({ provider:'ollama', estimated:true, cost: { total: estimatedCost,
  input, output }, modelId })`. Also write a `usage` execution_event per call for the feed.

### H.2 Aggregation + labelling

- `src/server/repositories/execution-repo.ts`:
  `getUsageSummaryForHouse` gains `estimated: boolean` (`max(estimated)` over the house's
  rows). `getUsageSummaryForTask` / `CostSummary` similarly gain an optional `estimated`.
  `src/shared/types.ts`: `HouseUsageSummary.estimated: boolean`; `CostSummary.estimated?: boolean`.
- UI (Stage J): the `Usage & quest` card in `house-overview.tsx` renders an "estimated"
  badge next to cost when `usage.estimated`; the Court plan cost line does the same when
  the rollup includes estimates.

### H.3 Tests

- `tests/unit/ollama-pricing.test.ts` (new): `estimateCost` math; missing model → 0 cost but
  still `estimated=true`; parse malformed `extra` safely.
- Extend `tests/unit/execution-service.test.ts` / `tests/integration/phase3-artifacts-usage.test.ts`:
  a mixed house (one estimated, one provider-reported row) → `estimated` is true; all
  provider-reported → false.

---

## 12. Stage I — Worktree exploration, flag-gated, default OFF (S)

**Goal:** satisfy §9's "explore `/experimental/worktree`" without shipping behavior.

- **Scope note:** `/experimental/worktree` is an **OpenCode** endpoint (see §0.2.8). It has
  nothing to do with the Ollama loop. This stage is a scaffold only.
- Setting: `experimental.worktreeIsolation` (boolean, default `false`) in the Settings page,
  persisted in the default provider config `extra` (or `localStorage` alongside reduced-motion
  if we keep it UI-only). Recommend `extra` so the engine can read it.
- `OpencodeClient.worktree()` — add an experimental method that calls the endpoint **only
  when the flag is on**; otherwise no code path invokes it. Document it as unverified against
  the installed server (the endpoint is experimental and not in the client's verified set).
- Default: no behavior change; the flag is inert. No test asserts real isolation (no server
  on this machine).
- Tests: a flag-off unit test proving no call is made; a flag-on test with an injected
  `fetchImpl` asserting the request shape only.

**Honesty:** this stage is deliberately a stub. If the user prefers to drop it entirely
until a live OpenCode worktree endpoint can be verified, it is the only genuinely optional
stage (Open Question Q7).

---

## 13. Stage J — UI surface (M)

| Surface | File | Change |
|---|---|---|
| Ollama selection hints | `src/components/houses/house-form.tsx` | When `executionProvider === 'ollama'`, show a hint (native runtime, pause/resume supported) and query an Ollama health endpoint; keep the free-text model input (or a picker from Stage B's tags). Provider Select already exists. |
| Paused runtime badge | `src/components/houses/runtime-status-badge.tsx` (+ `execution-service.ts` `deriveRuntimeStatus`) | Add `paused` mapping (Q3) — label "Paused", muted/gold. |
| Paused task badge | `src/components/houses/task-status-badge.tsx` | Add `paused` style; ensure `isTerminalStatus` excludes it. |
| Pause/Resume controls | house panel / quest board task row | Buttons calling the Stage G routes; disabled/hidden for OpenCode houses (provider-aware). |
| Estimated cost label | `src/components/houses/overview/house-overview.tsx`, Court cost line (`plan-board.tsx`) | "estimated" badge when the summary/dto flag is true. |
| Pricing editor | `src/app/settings/page.tsx` | A `modelPricing` table editor writing to the default Ollama provider config's `extra` via `PATCH /api/provider-configs/{id}`. |
| Worktree flag | `src/app/settings/page.tsx` | Toggle, default off (Stage I). |
| Activity labels | `src/components/houses/activity/describe-event.ts` | Describe Ollama `tool_call`/`tool_result` (payload `{ tool: { name/input } }`) and `{ pause: true/false }` message events. Additive + unit-tested. |

**Animation rule:** any pause/estimated affordance uses transform/opacity only and respects
`.velaris-reduced-motion` (the `globals.css` convention). Prefer static badges; map-level
paused animation is deferred (Open Question Q10).

### J.1 Tests

- Extend `tests/unit/activity-describe-event.test.ts` for Ollama tool/pause labels.
- `tests/e2e/phase5-ollama.spec.ts` (new; engine OFF, rows seeded via `better-sqlite3`):
  1. Create a house via the form with `executionProvider='ollama'` → persisted
     (assert via `GET /api/houses`).
  2. Seed an Ollama session/task in `paused` → `/houses/{id}` shows the Paused badge; the
     Pause/Resume control reflects state; the estimated badge renders on a seeded estimated
     usage row.
  3. Assert an OpenCode house's task does **not** show a Pause control (provider-aware).
  4. `/settings` pricing editor persists a price and it round-trips on reload.
- No live Ollama is started. Mocked equivalents live in the vitest suites.

---

## 14. Testing strategy (consolidated)

### 14.1 Conventions to follow (verified)

- Unit: `tests/unit/**` and `src/**/*.test.ts`; environment `node`; real temp DB +
  `migrate()` + `resetDbForTests()` for DB-backed tests (see `runner-status-machine.test.ts`).
- Integration: `tests/integration/**`, `VELARIS_DB_PATH` set **before importing route
  modules**, `resetDbForTests()` + `resetBootstrapForTests()` in `beforeEach`, invoke
  handlers with `new NextRequest()` against a temp DB (`api-routes.test.ts` contract).
- E2E: engine off, rows seeded with `better-sqlite3`, `workers: 1`, shared e2e DB (wiped by
  the Playwright webServer command). Never point the e2e DB at a real Ollama/OpenCode server.
- **No local Ollama server exists.** Every Ollama test injects `fetchImpl` or mocks
  `OllamaClient.chat`. The deterministic mocked smoke is `tests/unit/ollama-runtime.test.ts`
  (a scripted three-call tool loop), not a live Playwright run.
- Never run `npm run lint` (AGENTS.md). Zero new dependencies.

### 14.2 New/changed test files

| File | Covers |
|---|---|
| `tests/unit/ollama-client.test.ts` (new) | HTTP client, health, chat parsing, base URL. |
| `tests/unit/ollama-tools.test.ts` (new) | registry, fs/shell allowlist enforcement, network-off. |
| `tests/unit/ollama-permissions.test.ts` (new) | gating matrix. |
| `tests/unit/ollama-approval.test.ts` (new) | approval rows + reply→execute/deny. |
| `tests/unit/ollama-runtime.test.ts` (new) | tool loop, memory, terminal states, cancel, failure. |
| `tests/unit/ollama-memory.test.ts` (new) | message reconstruction + trimming. |
| `tests/unit/ollama-pause.test.ts` (new) | native pause/resume. |
| `tests/unit/ollama-pricing.test.ts` (new) | estimate math + parse. |
| `tests/unit/provider-seam.test.ts` (new) | capability flags, factory, per-provider health. |
| `tests/unit/queue-ollama.test.ts` (new) | queue routes Ollama vs OpenCode. |
| `tests/unit/queue-loop.test.ts` (extend) | OpenCode health-gate regression preserved. |
| `tests/unit/schemas.test.ts` (extend) | paused statuses, `tool` role. |
| `tests/unit/repositories.test.ts` (extend) | tool message round-trip. |
| `tests/unit/execution-service.test.ts` (extend) | estimated aggregation. |
| `tests/unit/activity-describe-event.test.ts` (extend) | Ollama tool/pause labels. |
| `tests/integration/ollama-pause-routes.test.ts` (new) | pause/resume 200/409/404. |
| `tests/integration/ollama-usage.test.ts` (new, optional) | estimated flag surfaces via API. |
| `tests/e2e/phase5-ollama.spec.ts` (new) | UI: provider selection, paused badge, estimated label. |

### 14.3 Gate order

`npx tsc --noEmit` → `npm test` → `npm run test:e2e` (UI/routes changed ⇒ all three).
Never `npm run lint`. No dependency changes.

---

## 15. Acceptance checklist (mapped to IMPLEMENTATION_PLAN §9)

> **Status as of Stages G–J implementation (2026-09-24; FINAL phase-gate
> counts 2026-09-24).** Stages A–F were already green (uncommitted). Stages G–J are
> now implemented and green. The two live-only items (a real `@real` Ollama smoke
> and `/experimental/worktree` live isolation) remain explicitly **unverifiable** on
> this machine and stay covered by mocks. Gates: `npx tsc --noEmit` **0**;
> `npm test` **706** vitest (was 641 mid-phase, 616 pre-phase); `npm run test:e2e`
> **39** (was 34). See `docs/IMPLEMENTATION_PLAN.md` §9 "Acceptance & Retro
> (2026-09-24)". `npm run lint` never run; no dependency changes; nothing committed.

- [x] An `executionProvider='ollama'` house completes a **research task using tools**
      (mocked Ollama in the deterministic smoke; the loop executes `fs_read`/`fs_write`
      within the allowlist and feeds `tool_result`s back). — `tests/unit/ollama-runtime.test.ts`.
- [x] **Permission gating is correct**: reads in-allowlist execute; writes respect the
      `fileSystem` mode; shell respects `shell`; network is denied by default; out-of-allowlist
      is always a user decision; approvals land in the Roost via the existing rows and the
      respond route resumes the loop. — `ollama-permissions` / `ollama-approval`.
- [x] **Pausing actually suspends the loop**: no new model call or tool execution occurs
      while paused; resume continues in place from `agent_messages` memory. OpenCode houses
      correctly report that they cannot pause (409). — Stage G: `tests/unit/ollama-pause.test.ts`
      + `tests/integration/ollama-pause-routes.test.ts`.
- [x] **Costs are marked estimates**: every Ollama `usage_records` row has `estimated=1`;
      the house/Court cost surfaces an "estimated" label; provider-reported OpenCode rows
      stay `estimated=0`. — Stage H: `tests/unit/ollama-pricing.test.ts` + aggregation
      extension in `execution-service`/`phase3-artifacts-usage`.
- [x] The engine is the only writer of execution tables; the web process adds only the
      pause/resume intent routes and the existing approval-response write. — pause/resume
      routes record intent only (integration-asserted); the Ollama loop in the engine does the
      actual suspend/resume.
- [x] OpenCode behavior is unchanged: `queue-loop`, `queue-highlord`, `runner-status-machine`,
      `opencode-client`, and Phase 4 e2e suites stay green.
- [x] No new `execution_events` type; event model and approval pipeline reused.
- [x] Migration `0004_*` committed with `constants.ts`/`types.ts` parity; no dependency
      changes; `npm run lint` never run.
- [x] Gates green: `npx tsc --noEmit` (0), `npm test` (706), `npm run test:e2e` (39).

### Implementation note (Stages G–J)
- **Stage G** — Native pause/resume: `POST /api/tasks/[id]/pause` + `.../resume` record the
  user's intent only (web never runs an agent task). The engine's Ollama loop suspends in place
  between steps by observing the session/task rows flipped to `paused`/`running`. Pause during a
  pending approval keeps the approval row alive and waits; resume + approve continues. Verified in
  `ollama-pause` (unit + integration).
- **Stage H** — Cost estimation: `src/server/execution/ollama/pricing.ts` reads
  `provider_configs.extra.modelPricing` (default Ollama config, seeded `{}`). Ollama
  `prompt_eval_count`/`eval_count` map 1:1 to input/output tokens. Missing price ⇒ cost 0 but the
  row/aggregate still flags `estimated=true`. `estimated` is additive on `CostSummary`/
  `HouseUsageSummary` and surfaced on house overview, plan-board cost line, and (via the shared
  summary) task results.
- **Stage I** — Worktree isolation is an INERT SCAFFOLD: `experimental.worktreeIsolation`
  default OFF, OpenCode-only. It adds `OpencodeClient.worktree()` (the `/experimental/worktree`
  request shape) + a Settings toggle that writes the flag to the default OpenCode config's
  `extra`. When OFF (default) no code path invokes it; no test asserts live isolation.
- **Stage J** — UI surface: Ollama provider hints + per-house network opt-in hint in the house
  form; provider-aware pause/resume controls on the house detail page; `estimated` labels on
  house overview + plan-board cost; a Settings pricing editor (persists to the default Ollama
  config); the Settings worktree flag; model picker sources from Ollama `/api/tags` when
  `providerId=ollama` (free-text fallback preserved); High Lord guard returns 422 for
  `executionProvider='ollama'` on a `high_lord` house.

### What cannot be verified live (and how it is covered)

- **No local Ollama server** (IMPLEMENTATION_PLAN §2; `ollama` client 0.31.1 installed but
  no server). Live smoke is impossible here. Covered by:
  (a) `tests/unit/ollama-runtime.test.ts` — a scripted, deterministic mocked tool loop that
  exercises the full path (model call → tool_use → gate → execute → tool_result → repeat →
  final answer → usage), including an approval round-trip;
  (b) `tests/unit/ollama-client.test.ts` pinned to fixture HTTP bodies.
  A `@real`-tagged opt-in smoke (create an Ollama house → run a task against
  `OLLAMA_BASE_URL`) is **out of scope for the gate** and must be skipped when no server is up.
- **`/experimental/worktree`** is unverified against the installed OpenCode version; Stage I
  is flag-off by default and tested only for "no call when off".

---

## 16. Open Questions / User Decisions

Each has a recommended default that matches codebase conventions so it can be accepted
quickly. Decisions will be captured in an Addendum (§18) that supersedes the named sections.

**Q1. Ollama API surface.** `/api/chat` (native) vs `/api/generate` (legacy) vs
`/v1/chat/completions` (OpenAI-compatible)?
→ **Recommend native `POST /api/chat` with `stream:false`, `tools:[…]`, `messages:[…]`;
health via `GET /api/version`; models via `GET /api/tags`.** It is the documented
tool-calling surface and returns `prompt_eval_count`/`eval_count` for estimates. Raw
`fetch`; no dep.

**Q2. Tool-call strategy across Ollama models.** Native tool-calling vs a prompt-parsed
ReAct-style loop?
→ **Recommend native `message.tool_calls` first, with the tool-defs sent in the request.**
Prompt-parsed fallback is deferred (model-dependent reliability, needs its own fixtures).
Document that models without tool support will answer conversationally (no tools executed) —
the loop still terminates `completed`.

**Q3. How to represent "paused".** Add `'paused'` to `SESSION_STATUSES` + `TASK_STATUSES`
(CHECK rebuild migration, badge/map ripple) vs keep statuses and store a boolean in
`execution_preferences`?
→ **Recommend adding the statuses** (symmetric with the existing state machine, honest UI,
engine-owned). If the CHECK rebuild is judged too risky, fall back to a boolean
(`execution_preferences.ollama.paused`) with a task left `running` and a derived runtime
badge — then Stage C drops the `tasks`/`execution_sessions` CHECK changes.

**Q4. Tool-loop memory persistence.** Extend `agent_messages` with `tool_calls` +
`tool_call_id` + role `'tool'` vs a separate `ollama_turns` table?
→ **Recommend extending `agent_messages`** (one canonical conversation store; OpenCode
ignores the new columns; no join). This reconciles the doc/code role mismatch.

**Q5. Pricing source & seed values.** Where does the table live and what seeds it?
→ **Recommend `provider_configs.extra.modelPricing` on the default Ollama config, seeded
empty (`{}`) because local-Ollama pricing is unknown; a Settings editor lets the user enter
per-1M input/output prices.** Missing price ⇒ cost `0` but still `estimated=true` (honest).

**Q6. Where the web-fetch flag lives.** Per-house vs global.
→ **Recommend per-house** (`tools` list + `permissions.network`), with network defaulting to
`deny` and the tool absent from the registry unless enabled. Optionally a global kill-switch
in Settings defaulting off. This matches the per-house permission model already in the form.

**Q7. Worktree flag naming / default / scope.**
→ **Recommend `experimental.worktreeIsolation`, default `false`, OpenCode-only, scaffold
only (no verified live behavior).** Alternatively drop Stage I entirely until the endpoint
can be verified — it is the only fully optional stage.

**Q8. Model picker for Ollama.** Extend `/api/models` vs a per-house provider toggle.
→ **Recommend extending `GET /api/models` to source from the Ollama provider when
`providerId=ollama`** (via `OllamaClient.listModels()` → `/api/tags`), keeping the existing
free-text fallback so house creation works with no server. The house form's provider Select
is the per-house toggle and already exists.

**Q9. Can the High Lord house use `executionProvider='ollama'`?** The High Lord seed is
OpenCode and steering relies on OpenCode `getSession`/`listMessages` (`orchestrator.ts:709-785`).
→ **Recommend disallowing it in Phase 5**: guard the house PATCH for `kind='high_lord'` +
`executionProvider='ollama'` with 422 ("the Court's planning session requires OpenCode"),
so a user edit cannot silently break steering. Revisit when an Ollama planner session lands.

**Q10. Paused visual scope.** Map animation vs badge only.
→ **Recommend badge + runtime status only in Phase 5**; defer the map paused animation
(touches `CityVisualState`/`animation-map.ts` and the Phase 3 perf budget) to Phase 5.1.

**Q11. `risky_only` semantics for Ollama tools.** The OpenCode path treats `risky_only`
as `always` (`runner.ts:481`).
→ **Recommend identical parity** (treat as `always`), documented; no new risk classifier.

**Q12. Estimated-cost surface.** House summary only vs per-task/plan too.
→ **Recommend house summary + Court plan rollup + task results** via an optional
`estimated` field on `CostSummary`/`HouseUsageSummary` (additive).

---

## 17. Risks & mitigations

1. **OpenCode regression from the seam (Stage A).** Highest risk. The health gate moves from
   pre-claim global to per-task; `RunContext`/`QueueDeps` may need additive fields.
   Mitigation: keep the OpenCode branch byte-identical, add explicit regression tests, run
   the full OpenCode + Phase 4 suites before touching the Ollama branch.
2. **CHECK-constraint table rebuild (Stage C).** No precedent in this repo; drizzle-kit may
   rewrite tables. Mitigation: inspect generated SQL, test `migrate()` against a copy of a
   real dev DB, fall back to Q3's boolean option if fragile.
3. **Tool-loop complexity / infinite loops.** Mitigation: a hard step cap per session
   (`OLLAMA_DEFAULTS.MAX_TOOL_STEPS`, default e.g. 20), a wall-clock timeout mirroring the
   runner's 2h, and a per-session token cap; any cap breach → `failed` with a clear event.
4. **Path escape via symlinks/new files.** `resolveSafePath` requires the candidate to
   exist (realpath). For `fs_write` to a new file, resolve the **parent directory** and
   join the basename, then prefix-check — document and unit-test this explicitly.
5. **Shell execution risk.** Use `execFile`/`spawn` with an argument array (never a shell
   string built from model output) and a timeout; default `shell` mode is `ask`. Log every
   shell call as an event. (Full `audit_log` is Phase 6.)
6. **Approval storms / duplicates.** Synthetic `provider_request_id` (`ollama:<session>:<call>`)
   + `createApprovalRequest`'s UNIQUE dedupe prevents duplicate birds on retry; unit-tested.
7. **Pause/resume crash windows.** Because turns are persisted before the next call, a crash
   between pause and resume is recoverable: the generic reconcile marks the session
   `interrupted` and requeues; verify `paused` is included in in-flight queries.
8. **Memory growth.** Tool results can be huge. Cap persisted tool output (truncate + store
   a note) and trim context on rebuild.
9. **`getActiveSessionForHouse` treats `paused` as inactive unless updated** — if missed, a
   paused session could be considered "no active session" and the queue could start a second
   task for the same house. Mitigation: include `paused` in the active-session predicate
   (Stage C ripple) and unit-test.
10. **No live provider.** All Ollama behavior is mock-verified only; a real `@real` smoke is
    opt-in and off the gate. State this in the phase retro.

---

## 18. Addendum — User Decisions (2026-09-24)

All Q1–Q12 answered: **the user accepted every recommended default** ("accept all defaults").
These supersede the corresponding sections above.

| Q | Decision | Supersedes |
|---|---|---|
| Q1 | Native `POST /api/chat` (`stream:false`, `tools[]`, `messages[]`); health `GET /api/version`; models `GET /api/tags`; raw `fetch`, no dep | §5 (Stage B) |
| Q2 | Native `message.tool_calls` only; prompt-parsed ReAct fallback DEFERRED; models without tool support answer conversationally and the loop terminates `completed` | §9 (Stage F), §7 (Stage D) |
| Q3 | Add `'paused'` to `SESSION_STATUSES` + `TASK_STATUSES` (CHECK rebuild migration). Fallback to boolean `execution_preferences.ollama.paused` ONLY if the rebuild proves fragile (see §17 risk 2) | §6 C.1/C.2/C.4, §10 (Stage G) |
| Q4 | Extend `agent_messages` with `tool_calls` + `tool_call_id` + role `'tool'`; OpenCode ignores new columns; no new table | §6 C.3, §9 (Stage F) |
| Q5 | Pricing lives in `provider_configs.extra.modelPricing` on the default Ollama config, seeded empty `{}`; Settings editor for per-1M input/output; missing price ⇒ cost `0` but `estimated=true` | §11 (Stage H), §13 (Stage J) |
| Q6 | Web-fetch flag is PER-HOUSE (`tools` list + `permissions.network`), default `deny`, tool absent unless enabled; optional global kill-switch in Settings, default off | §7 (Stage D), §8 (Stage E) |
| Q7 | `experimental.worktreeIsolation`, default `false`, OpenCode-only, SCAFFOLD ONLY (endpoint unverifiable without a live server). Stage I is retained as the inert scaffold | §12 (Stage I) |
| Q8 | Extend `GET /api/models` to source from Ollama (`/api/tags`) when `providerId=ollama`, keeping free-text fallback; house-form provider Select remains the per-house toggle | §13 (Stage J) |
| Q9 | High Lord `executionProvider='ollama'` DISALLOWED with 422 ("the Court's planning session requires OpenCode"); steering depends on OpenCode `getSession`/`listMessages` | §13 (Stage J), §9 (Stage F) |
| Q10 | Paused visual is badge + runtime status only; map paused animation DEFERRED to Phase 5.1 | §13 (Stage J) |
| Q11 | `risky_only` treated as `always` (parity with OpenCode `runner.ts:481`); no new risk classifier | §8 (Stage E) |
| Q12 | Estimated cost surfaced on house summary + Court plan rollup + task results via an additive optional `estimated` field on `CostSummary`/`HouseUsageSummary` | §11 (Stage H), §13 (Stage J) |

Stage I is **kept** (Q7 default = retain the inert scaffold). Standing conventions apply:
`npx tsc --noEmit` → `npm test` → `npm run test:e2e`; never `npm run lint`; no dependency
changes; engine single-writer; e2e has no engine (seed rows directly); Ollama HTTP is mocked
in vitest; transform/opacity animations only, reduced-motion safe. Acceptance for the
ollama-direct research task is proven by a deterministic MOCKED smoke (no local Ollama here),
with an opt-in off-gate `@real` smoke documented in the retro.
