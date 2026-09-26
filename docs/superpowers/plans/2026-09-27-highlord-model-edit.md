# Plan — Allow editing the High Lord's existing agent (model edit)

**Date:** 2026-09-27
**Goal (bug fix):** The only model-editing UI affordance for the High Lord is the house
detail → **Agents** tab → **Edit**, which PATCHes `/api/houses/{id}/agents/{agentId}`.
That route's blanket `guardHighLordAgents` throws 422, so the HL model cannot be changed in
the UI, even though house-level `PATCH /api/houses/{id}` allows it
(`tests/integration/house-highlord-guard.test.ts:109` locks this in). The two endpoints
disagree and only the blocked one is reachable.

## Decision (Option A, approved)
Relax the guard so the High Lord's **existing single agent can be updated** (the panel sends
name+role+configuration, so a config-only relaxation would still 422). Agent **CREATE** and
**DELETE** on a `high_lord` house remain 422 ("roster is fixed"). No engine code depends on
the HL agent name; the real dependency is the OpenCode planning path, so setting
`executionProvider='ollama'` on the HL agent must still 422 with the same message as
`updateHouseService`.

## Non-goals
- No schema/migration change (`houseAgentUpdateSchema` already permits name/role/partial config).
- No new dependencies; no change to `src/shared/**`; no engine changes.
- Do not weaken HL house status/delete guards or the Ollama-executionProvider guard.
- No new nav/route; keep §8 contracts and single-writer discipline.

## Files
| File | Change |
|---|---|
| `src/server/services/house-service.ts` | Split the guard; relax `updateAgentService`; add HL Ollama reject. |
| `src/components/houses/house-agents-panel.tsx` | Add `rosterFixed?: boolean`; hide Add + per-agent delete; keep Edit. |
| `src/app/houses/[id]/page.tsx` | Pass `rosterFixed={house.kind === "high_lord"}`. |
| `tests/unit/house-agents.test.ts` | HL: update succeeds, config persists, ollama rejects; create/delete still throw. |
| `tests/integration/house-agents-routes.test.ts` | HL PATCH → 200 + persistence; create/delete/ollama → 422. |
| `tests/integration/house-highlord-guard.test.ts` | No change (house-level model edit stays 200). Verify green. |
| `tests/e2e/*` | No changes required (see Test impact). |

## Per-file changes

### 1. `src/server/services/house-service.ts`
- **Rename** `guardHighLordAgents` → `guardHighLordRoster`. Keep body/`HouseNotFoundError`
  behavior and the 422 `HighLordTransitionError` message
  (`"The High Lord house's agent roster is fixed — it cannot be changed"`). Update the doc
  comment: the **roster** (create/delete) is fixed; the existing agent stays editable.
- Call it **only** from `createAgentService` and `deleteAgentService`; remove the call from
  `updateAgentService`.
- In `updateAgentService` (currently line ~248), after `houseAgentUpdateSchema.parse(input)`,
  replace the blanket guard with:
  ```
  if ((parsed.configuration as Partial<HouseConfiguration> | undefined)?.executionProvider === "ollama") {
    const house = getHouse(db, houseId);
    if (house?.kind === "high_lord") {
      throw new HighLordTransitionError(
        "The Court's planning session requires OpenCode — the High Lord cannot use the Ollama runtime",
      );
    }
  }
  ```
  Throw **only** when the patch actually sets `ollama` (mirror `updateHouseService` ~line 93).
- Preserve ordering: parse → Ollama-on-HL reject → existing agent-belongs-to-house check
  (404 `AgentNotFoundError`) → `repoUpdateAgent` → audit write. Audit/changed-key logic
  unchanged.
- No change to `createHouseService`, `updateHouseService`, status/delete guards.

### 2. `src/components/houses/house-agents-panel.tsx`
- Add `rosterFixed?: boolean` to `Props` (default `false`).
- When `rosterFixed` is true: do not render the header **Add agent** button (line ~194) and
  do not render the per-agent **delete** (`Trash2`) button; keep the **Edit** button enabled.
  The existing `isDefault` delete-disable logic remains for non-HL houses.
- Keep dialog copy working for both create (normal houses) and edit (all). For the HL the
  dialog opens in edit mode only.

### 3. `src/app/houses/[id]/page.tsx`
- Pass `rosterFixed={house.kind === "high_lord"}` to `<HouseAgentsPanel>` (line ~280).

## Test impact
- **Unit (`tests/unit/house-agents.test.ts`, ~line 332):** replace the
  "rejects agent CRUD on the High Lord house" test. New assertions:
  1. `updateAgentService(db, hl.id, hlAgent.id, { name: "Y" })` **succeeds** and returns the
     updated agent.
  2. Updating `configuration.modelId` on the HL agent persists (re-read via
     `listAgentsForHouse`/`getHouse`).
  3. `updateAgentService(..., { configuration: { executionProvider: "ollama" } })` throws
     `HighLordTransitionError`.
  4. `createAgentService` and `deleteAgentService` on the HL still throw
     `HighLordTransitionError`.
- **Integration (`tests/integration/house-agents-routes.test.ts`, ~line 249):** rewrite the
  "agent CRUD on the High Lord house" block: PATCH `{ configuration: { modelId: ... } }`
  (and/or `name`) → **200** and persisted via `GET /api/houses/{id}`; POST create → 422;
  DELETE → 422; PATCH `{ configuration: { executionProvider: "ollama" } }` → 422 with
  `/planning session requires OpenCode/i`. Keep the existing 409 last-agent and normal-house
  PATCH coverage untouched.
- **E2E:** no spec asserts the HL agents panel hides Edit or shows Add/delete.
  `tests/e2e/phase6-multi-agent.spec.ts` exercises Add/Edit on a **normal** house (unaﬀected).
  `tests/e2e/phase4-court.spec.ts` only checks the "Configure the High Lord" link href.
  **No e2e changes expected**; re-run to confirm.
- `tests/integration/house-highlord-guard.test.ts` unchanged — house-level model edit still 200.

## Acceptance criteria
- `PATCH /api/houses/{hlId}/agents/{hlAgentId}` with `name` + `configuration` returns 200 and
  the change is persisted; the HL model can be changed from the UI Agents tab.
- HL agent CREATE and DELETE still return 422; `executionProvider='ollama'` on the HL agent
  still returns 422 with the OpenCode-planning message.
- On a `high_lord` house the Agents panel shows **Edit** but no **Add agent** / delete.
- Normal houses keep full add/edit/delete behavior; last-agent 409 unchanged.
- `house-highlord-guard.test.ts` stays green (no regression to house-level editability).

## Gates (must end green)
```bash
npx tsc --noEmit          # baseline 0
npm test                  # baseline 1067 vitest (count may rise with new cases)
# free port 3000 first, then:
npm run test:e2e          # baseline 51
```
Do **not** run `npm run lint`. No dependency changes.

## Potential risks
- **Ollama selection in the HL edit dialog:** the panel's execution-provider select is disabled
  when `rosterFixed`, with an `aria-describedby`-associated hint explaining that the High Lord
  must stay on OpenCode. On open the draft is coerced to `opencode` for roster-fixed houses, so a
  legacy/manual HL agent stored with `executionProvider='ollama'` cannot pin the disabled select
  and every submit re-send `ollama` (permanent 422). Normal houses are unaffected.
- **Error-order change:** removing the pre-existence guard means a cross-house/missing agent
  still 404s via the belongs-to-house check; confirm the existing 404 assertions stay green.
- **E2E shared DB:** unchanged behavior for normal houses, so no seed/cleanup changes needed.
