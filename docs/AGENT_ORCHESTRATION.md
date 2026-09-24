# Velaris — Agent Orchestration

How a quest actually gets done: task lifecycle, the provider adapter contract, event
mapping, house status machine, messenger-bird approvals, and previews of the High Lord
(Phase 4) and the Ollama-native agent runtime (Phase 5).

Companion documents: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) ·
[ARCHITECTURE.md](./ARCHITECTURE.md).

All OpenCode endpoints below are **verified against v1.18.31** (OpenAPI at `/doc`, 162
paths). Nothing here invents endpoints.

---

## 1. Execution Lifecycle (end-to-end)

```
 CREATE            ENGINE                         OPENCODE                    USER/UI
 ───────           ───────                        ────────                    ───────
 task created ─→ poll queue (1s)
 (status=queued)   house active? allowlist ok?
                      │
                      ▼
                  ensure OpenCode server
                  (GET /api/health → spawn if needed)
                      │
                      ▼
                  POST /session {directory} ──────→ session id
                  POST /session/{id}/init
                  POST /session/{id}/prompt ───────→ agent starts working
                      │                                │
                      ▼                                │ SSE: GET /event?directory=…
                  map events → execution_events rows ←─┘  (message parts, tool calls,
                      │                                     permissions, questions)
                      ├─ permission.updated ─→ approval_requests(pending)
                      │                        + notifications  ──────────→ 🐦 bird appears
                      │                                                         user Approve/Reject/Reply
                      ▼                                                         │
                  poll replied approvals ←──────────────────────────────────────┘
                      │
                      ▼
                  POST /permission/{requestID}/reply   (or /question/{id}/reply|/reject)
                      │                                → agent resumes
                      ▼
                  session completes (session.updated / message end)
                      │
                      ▼
                  GET /session/{id} → cost, tokens
                  GET /session/{id}/diff → artifacts
                      │
                      ▼
                  task → completed/failed · house → completed (fireworks once per task)
                      │
                      ▼
                  results snapshot (summary, files, diff, tests, errors) → Archives
```

Key persistence rules:
- A task may have **multiple execution sessions** (retry, resume-after-abort, High Lord
  re-delegation). The task row never stores execution state; sessions do.
- Every engine decision is a row write first, then a provider call. Crash recovery
  reconciles from rows (ARCHITECTURE §9).
- The queue respects per-house `concurrency` and skips houses that are
  `disabled`/`archived` (task stays `queued` with a `blocked_reason` event).

---

## 2. AgentExecutionProvider Adapter (TypeScript)

One interface, two implementations (OpenCode now, Ollama-direct in Phase 5). The engine
codes against this interface only.

```ts
// src/engine/adapters/types.ts
import type { ExecutionEvent, ApprovalRequestInput } from '../../shared/types'

export interface StartTaskInput {
  taskId: string
  sessionId: string            // Velaris execution_session id
  workingDirectory: string     // validated against allowlist before we get here
  systemPrompt: string         // house system prompt
  taskPrompt: string           // title + description + attachments + execution prefs
  aiProvider: string           // OpenCode providerID, e.g. 'ollama-cloud'
  modelId: string              // e.g. 'glm-5.3'
  approvalPolicy: 'never' | 'always' | 'risky_only'
}

export interface SendMessageInput {
  sessionId: string            // Velaris session id
  message: string
  replyToApproval?: { providerRequestId: string; action: 'approve' | 'reject' | 'reply'; message?: string }
}

export interface SessionStatus {
  providerSessionId: string | null
  status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'aborted' | 'interrupted'
  cost?: { total: number; inputTokens: number; outputTokens: number; reasoningTokens?: number; cacheTokens?: number }
}

export interface AgentExecutionProvider {
  startTask(input: StartTaskInput): Promise<{ providerSessionId: string }>
  sendMessage(input: SendMessageInput): Promise<void>   // chat, follow-ups, resume-after-abort
  cancelTask(providerSessionId: string): Promise<void>  // OpenCode: POST /session/{id}/abort
  getStatus(providerSessionId: string): Promise<SessionStatus>  // OpenCode: GET /session/{id}
  getEvents(directories: string[]): AsyncIterable<ProviderEvent> // OpenCode: GET /event?directory=… SSE
  respondToApproval(input: { kind: 'permission' | 'question'; providerRequestId: string;
                             action: 'approve' | 'reject' | 'reply'; message?: string }): Promise<void>
    // permission → POST /permission/{requestID}/reply
    // question   → POST /question/{requestID}/reply | /question/{requestID}/reject
  getDiff(providerSessionId: string): Promise<string>  // OpenCode: GET /session/{id}/diff
  listModels(): Promise<{ id: string; providerID: string }[]>  // OpenCode: GET /api/model
  health(): Promise<boolean>                           // OpenCode: GET /api/health
}
```

### 2.1 Explicit Limitations (documented, never simulated)

| Limitation | Reality (v1.18.31) | How Velaris behaves |
|---|---|---|
| **No pause/resume** | Only `POST /session/{id}/abort` exists | UI "Pause" on an OpenCode house = abort + persist last assistant message + `execution_session.status='aborted'` with `pause_context` JSON. "Resume" = new session + `sendMessage` with a context-restoring prompt. House shows `paused` (honest label: "paused (session aborted — resumable)"). Ollama-direct houses get *true* pause (§8). |
| No concurrent-session guarantee per directory | Sessions are directory-scoped; concurrent sessions in one directory risk conflicting edits | Task creation warns when the target directory already has a `running` session; queue serializes per working directory by default (parallel only across distinct directories or with user override). |
| Approvals are per-provider request ids | `GET /permission` lists pending; reply by `requestID` | Velaris stores `provider_request_id`; on engine reconnect, re-sync pending approvals from `GET /permission` + `GET /question`. |
| `/experimental/worktree`, `/vcs/*` exist but experimental | Future options only | MVP runs in the working directory directly, with approval gates. Flag-gated exploration in Phase 5. |

---

## 3. Event Mapping (OpenCode SSE → Velaris)

Engine subscribes `GET /event?directory=<workdir>` (optionally via `POST /event` filters).
The Event schema is in the OpenAPI doc; **the mapper must tolerate unknown event types
gracefully** (log `execution_events.type='unknown'` + payload, never crash, never drop).

| OpenCode event | Velaris ExecutionEvent | House status transition (§4) | UI effect (Phase 3) |
|---|---|---|---|
| session created / prompt sent | `session_started` | idle → planning (short window) → working | pulsing lights → glowing windows, chimney smoke |
| `message.updated` (assistant parts: text) | `message_part` `{role:'assistant', text}` | (working) | activity timeline append |
| `message.updated` (tool call part) | `tool_call` `{tool, args}` | working | timeline: tool chip |
| `part.updated` (tool result) | `tool_result` `{tool, ok, summary}` | working | timeline: result |
| `permission.updated` (pending) | `permission_request` | working → **waiting_approval** | 🐦 messenger bird + panel |
| `question.updated` (pending) | `question_request` | working → **waiting_input** | 🐦 messenger bird (clarification) |
| `permission.updated` / `question.updated` (resolved) | `status_change` | waiting_* → working | bird flies off, smoke resumes |
| `session.updated` (cost/tokens deltas) | `usage_update` | — | usage counter tick |
| `session.updated` (session end / idle) | `completion` (or `error` if failed) | working → completed / failed | fireworks (once per task) / error indicator |
| any unknown event type | `unknown` (raw payload kept) | none | nothing (logged) |

Mapping rules:
1. Every mapped event writes an `execution_events` row (single writer, autoincrement id) —
   this row *is* the SSE cursor for the browser feed (ARCHITECTURE §4).
2. Assistant **text and tool calls only** — chain-of-thought is OpenCode-internal and never
   surfaced. If a CoT-like part type appears, map to `unknown`.
3. A pending `permission`/`question` may also be discovered via the `GET /permission` /
   `GET /question` snapshots on reconnect — dedupe by `provider_request_id` (UNIQUE).
4. `part.updated` ordering can interleave; timeline renders by `execution_events.id`.

---

## 4. House Status State Machine

Runtime status is **derived** (not stored on the house row) from active sessions + the
latest mapped event — see transition triggers. Config status (`active`/`disabled`/
`archived`) is stored separately (Phase 1).

```
                          ┌──────────┐
             ┌───────────►│  idle    │◄───────────────────────────┐
             │            └────┬─────┘                            │
             │        session_started                            │ session end
             │                 ▼                                  │ (completed)
        cancel/abort      ┌──────────┐   permission/question   ┌──┴──────────┐
             │            │ planning │─────pending────────────► │ waiting_    │
             │            └────┬─────┘                          │ approval / │
             │        first tool_call/text part                 │ waiting_   │
             │                 ▼                                │ input      │
             │            ┌──────────┐   approval replied       └──────┬─────┘
             │   ┌───────►│ working  │◄────────────────────────────────┘
             │   │        └──┬───┬───┘
             │   │ tool/agent error │ repeated failure / stuck watchdog
             │   │              ▼   ▼
             │   │        ┌─────────┐ ┌────────┐
             │   │        │completed│ │blocked │──► escalation notification
             │   │        └─────────┘ └───┬────┘
             │   │                         │ clarified / resolved
             │   │ user pause              ▼
             │   │            ┌────────┐  (back to working)
             └───┴────────────┤ paused │
                            └────────┘
   offline = engine heartbeat stale OR provider health fails OR house disabled
```

| From | Trigger (source) | To |
|---|---|---|
| idle | `session_started` | planning |
| planning | first `message_part`/`tool_call` | working |
| working | `permission_request` pending | waiting_approval |
| working | `question_request` pending | waiting_input |
| waiting_approval / waiting_input | approval reply forwarded (`status_change`) | working |
| working | session end, no error | completed (then idle after fireworks/indicator window) |
| working | session end with error / failed init | failed |
| working | agent error event, or watchdog: no events for N min with pending state unknown | blocked (+ notification) |
| working | user Pause | paused (OpenCode: abort + context; see §2.1) |
| paused | user Resume (new session + context prompt) | planning |
| any | user Cancel → `POST /session/{id}/abort` | idle (task → cancelled) |
| any | engine offline / provider unhealthy / house disabled | offline |

Fireworks guard: `completed` animation fires once per **task** completion — tracked via
`notifications` kind `task_completed` existence for the task id (never re-fire on page
refresh), after which houses show the subtle completed indicator.

---

## 5. Messenger Bird Flow (approvals & clarifications)

```
 OpenCode event (permission.updated / question.updated, status=pending)
   │ engine
   ▼
 approval_requests row  (kind, provider_request_id UNIQUE, title, details JSON:
   │                    permission: {type, path?, command?} · question: {options?, text})
   ▼
 notifications row (kind='approval'|'clarification', house_id, task_id, read=0)
   │ web change-feed (500ms)
   ▼
 /api/stream push → bird animates above house + Roost unread count +1
   │ user clicks bird / Roost item
   ▼
 interactive panel: [View Details] [Approve] [Reject] [Reply…]
   │ POST /api/approvals/{id}/reply { action: 'approve'|'reject'|'reply', message? }
   │ web: approval_requests.status → approved/rejected/replied (+reply_message), notification.read=1
   ▼
 engine polls replied rows → provider call:
   permission: POST /permission/{requestID}/reply {…}      → agent resumes
   question:   POST /question/{requestID}/reply {…}         → agent resumes
               POST /question/{requestID}/reject           → agent re-plans / ends
   ▼
 status_change event → house working → bird flies off
```

**Policies & timeouts.** `approval_policy` gates *auto-resolve*, never the bird itself:
`risky_only` auto-approves in-allowlist file edits and creates a `read=1` informational
notification instead of a bird; `always` birds everything; `never` auto-approves only
allowlist-safe actions — any out-of-allowlist request **still birds** (safety override).
Pending approvals have a configurable `timeout_at` (default: none / task-scoped); when the
session aborts or completes, open approvals are auto-closed `status='rejected'` with
reason `session_ended`. Unread counts = `notifications WHERE read=0`, grouped by kind for
the Roost badge.

**Reply semantics.** Approve → confirm; Reject → deny + optional message (agent re-plans);
Reply → free-text clarification (for questions; for permissions acts as deny-with-guidance).

---

## 6. High Lord Design (Phase 4 preview)

The High Lord is a special house (`houses.kind='high_lord'`, auto-created in Phase 4) whose
"agent" is an orchestrator loop:

1. **Receive instruction** in the Court chat (a task with `house_id=high_lord`).
2. **Plan**: single model call with a planning system prompt that must return JSON matching
   `planSchema` (zod): `{ subtasks: [{ title, description, type, houseId? | houseHints,
   dependsOn: [ids], instructions, context, artifacts, completionRequirements }] }`.
   One repair retry on schema failure; fallback = single subtask for the best-matching house.
3. **Delegate**: each subtask becomes a `tasks` row linked via `subtasks` (parent_task_id,
    order_index, depends_on). `handoffs` rows carry source/destination **house ids** (not agent
    ids), instructions, context, artifacts, completion requirements.
4. **Schedule**: DAG execution — subtasks with unmet dependencies stay `queued`;
   independent branches run in parallel (different houses/directories; §2.1 serialization
   applies per directory).
5. **Monitor & consolidate**: High Lord watches child sessions (same event feed), may send
   follow-up instructions via `sendMessage`, and on all-children-terminal writes a
   consolidated summary on the parent task (results, files, diffs, cost rollup).

**Loop safeguards:** max delegation depth = 1 (High Lord subtasks may not be re-delegated to
the High Lord); max subtasks per plan (default 8, per-parent `executionPreferences.maxSubtasks`);
total plan token budget enforced via `usage_records` rollup (per-parent `tokenBudget`). A failed
subtask is retried (fresh child task rows) up to `ORCHESTRATION_DEFAULTS.MAX_SUBTASK_RETRIES` (3);
retry exhaustion or a token-budget breach **aborts the entire plan** — children cancelled,
parent `failed` with `execution_preferences.plan.abortReason`, partial consolidated output
preserved, and burning-house visuals on the Court + map. (The escalation-bird design from the
Phase 4 preview is removed — retry-then-abort replaces it.)

**Steering (in v1):** while a plan is active, Court chat messages reach the High Lord's resumable
planning session (via `POST /api/court/steer` writing an `agent_messages` row the orchestrator
relays); a plan-shaped reply revises the DAG (terminal subtasks untouched; a new subtask is
planned when its title doesn't match an existing one).

**Subtask statuses:** `planned | ready | delegated | in_flight | completed | failed | cancelled`
(orchestrator-owned scheduling state, distinct from the child task row's `tasks.status`).

**Phase 1 schema readiness** (already satisfied by ARCHITECTURE §6.1/§6.2): tasks carry
optional `house_id`/`project_id` (no orchestrator coupling), `subtasks.parent_task_id` +
`depends_on` support DAGs, `handoffs` captures structured context, and `houses.kind`
distinguishes the orchestrator without schema changes later.

---

## 7. Usage & Cost Tracking

**OpenCode houses (provider-reported, exact):** on session completion the engine reads
`GET /session/{id}` → `cost`, `tokens {input, output, reasoning, cache}` (verified fields)
and writes a `usage_records` row with `estimated=0`. Intermediate `session.updated` cost
deltas may also write rows (dedup by session id at completion: final row wins).

**Ollama-direct houses (Phase 5, estimates):** the runtime knows prompt/completion token
counts from the chat API response; a settings-managed pricing table
(`provider_configs.extra.modelPricing = { "<model>": { inputPer1M, outputPer1M } }`)
computes cost; every such row is written with `estimated=1` and the UI renders an
"estimated" badge.

**Aggregation surfaces (Phase 6):** per-house totals, per-task rollup (sum across sessions),
per-model/per-provider breakdowns, estimated-vs-reported comparison view. No hardcoded
model names anywhere — `model_id` always comes from configuration or the `GET /api/model`
picker.

---

## 8. Ollama-Native Agent Runtime (Phase 5)

For houses with `execution_provider='ollama'`, Velaris itself is the agent runtime — a bare
model API call is **not** an agent. Same `AgentExecutionProvider` interface; the engine
hosts the loop:

```
 ┌──────────────── engine (ollama-adapter) ─────────────────┐
 │ state: task → session row → agent_messages (DB)          │
 │ loop:                                                      │
 │   1. build messages: system prompt (house) + task prompt   │
 │      + memory (agent_messages, trimmed to ctx window)      │
 │      + tool definitions (fs/shell/git/web-fetch)            │
 │   2. POST /v1/chat (or native /api/chat) @ base_url        │
 │   3. response has tool_calls?                               │
 │        ├─ yes → permission gate each call:                  │
 │        │    · in-allowlist read  → execute                  │
 │        │    · in-allowlist write → execute if policy allows │
 │        │    · shell / network / out-of-allowlist →           │
 │        │      ApprovalRequest + bird → engine executes      │
 │        │      or rejects per reply, appends tool_result     │
 │        │      → continue loop                                │
 │        └─ no  → final answer → artifacts/results, complete  │
 │ pause: set session.paused flag → loop checks between       │
 │         steps → truly suspends; resume continues in-place   │
 └─────────────────────────────────────────────────────────────┘
```

Runtime components: tool registry (each tool = zod input schema + permission class + executor),
conversation memory persisted to `agent_messages`, task state machine mirroring §4 (native
pause/resume supported here — the honest contrast with OpenCode is documented in the UI),
cost rows per model call (`estimated=true`). Tests mock the Ollama HTTP API (no local
server on the dev machine — base_url is configurable for remote endpoints).

---

## 9. Workspace Safety Rules

1. **Allowlist at admission.** Task creation: `working_directory` must resolve
   (realpath) inside the assigned house's `workspace_allowlist`; assigning a project adds
   a prompt to extend the allowlist rather than silently allowing.
2. **Allowlist at runtime.** Engine-side: OpenCode permission requests for paths outside
   the allowlist always bird (even under `approval_policy='never'`). Ollama-direct: tool
   executor refuses out-of-allowlist paths outright.
3. **Approval classes.** read-in-allowlist (safe) · write-in-allowlist (policy-gated) ·
   shell exec (policy-gated, always logged to audit_log) · network (deny by default) ·
   out-of-allowlist (always user decision).
4. **Concurrency isolation (MVP).** One active session per working directory; parallel
   tasks require distinct directories. UI warns at task creation if the directory has a
   `running` session. (Future: per-session git branches; OpenCode exposes experimental
   `/experimental/worktree` — flag-gated Phase 5 exploration, not MVP.)
5. **Diff capture.** `GET /session/{id}/diff` after completion → stored as an `artifacts`
   row (kind `diff`) so results are reviewable even after the working tree changes.

---

## 10. Contract Test Checklist (Phase 2 gate)

- [ ] Adapter contract test pins every verified endpoint call (path + payload shape) against fixture responses.
- [ ] Event mapper: fixture SSE stream (incl. an unknown event type) → expected execution_events rows + status transitions; unknown tolerated.
- [ ] Approval round-trip: permission event → rows → reply API → adapter call assertion → status_change.
- [ ] Status machine: full transition table (§4) covered as data-driven unit tests.
- [ ] Crash recovery: kill engine mid-session → orphan reconciled (`interrupted`), requeue works, pending approvals re-synced from `GET /permission`/`GET /question`.
- [ ] Real-provider smoke (opt-in `@real` tag): create house → task → completion with actual `opencode serve`.