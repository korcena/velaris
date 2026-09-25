# Design — Default ACOTAR Houses (10 role houses + derived templates)

**Date:** 2026-09-25
**Status:** Approved (design); implementation plan pending
**Owner:** user (daily-driver Velaris instance)

## 1. Objective

Seed a usable, opinionated set of **ten default houses**, one agent each, covering the
roles the user needs for daily work — not only software development. Houses and agents are
named after *A Court of Thorns and Roses* (ACOTAR) characters and courts, fitting the app's
existing fantasy theme and its "Night Court city" map.

Each house is independently targetable, has its own permission posture, and is paired with a
**derived template** so an accidental delete or a bad edit is recoverable.

## 2. Non-goals

- Not renaming, editing, or touching the existing **High Lord** house or **House of Wind**.
- Not adding new permissions, tools, providers, or execution engines.
- Not building a template marketplace or a new management UI; the existing template picker and
  Settings manager already cover this.
- Not altering Phase 5's Ollama runtime or Phase 6's multi-agent model; each default house
  keeps exactly one agent.

## 3. The roster

House = a named court/place; agent = a character whose traits match the function.

| # | House | Agent | Role title | Function | Tools |
|---|---|---|---|---|---|
| 1 | Day Court | Helion | Spell-cleaver · software developer | Software Developer | fs, shell, git |
| 2 | House of Shadow | Azriel | Shadowsinger · software tester | Software Tester | fs, shell, git |
| 3 | Hewn City | Amren | The Second · software reviewer | Software Reviewer | fs, shell, git |
| 4 | The Library | Clotho | High Priestess of the Library · technical writer | Documentation | fs, git |
| 5 | Court of Truth | Morrigan | Truth-bearer · analyst | Analysis | fs |
| 6 | The Townhouse | Nuala | Keeper of the House · secretary | Admin / Secretary | fs, git |
| 7 | Summer Court | Tarquin | High Lord of Summer · accountant | Finance / Auditor | fs |
| 8 | Windhaven | Gwyn | Valkyrie archivist · researcher | Research | fs |
| 9 | The Crossing | Lucien | Emissary · liaison | Communications | fs |
| 10 | Illyria | Cassian | General of the Armies · operations lead | Operations / DevOps | fs, shell, git |

Roles 1–7 are the user's requested set; 8–10 (Research, Communications, Operations) are the
suggested additions, accepted by the user. Documentation and Research are deliberately split:
Clotho **produces** the record; Gwyn **finds and synthesises** the material.

## 4. Permissions (approved matrix)

`ask` = messenger-bird approval before acting. `allow` = no prompt. `deny` = tool/permission
unavailable.

| House | Filesystem | Shell | Git | Network | Approval policy |
|---|---|---|---|---|---|
| Day Court (Developer) | ask | ask | allow | ask | risky_only |
| House of Shadow (Tester) | ask | ask | allow | ask | risky_only |
| Hewn City (Reviewer) | ask | ask | allow | deny | always |
| The Library (Docs) | ask | deny | allow | deny | always |
| Court of Truth (Analysis) | ask | deny | deny | ask | always |
| The Townhouse (Admin) | ask | deny | allow | ask | always |
| Summer Court (Finance) | ask | deny | deny | deny | always |
| Windhaven (Research) | ask | deny | deny | ask | always |
| The Crossing (Comms) | ask | deny | deny | ask | always |
| Illyria (Operations) | ask | ask | allow | ask | risky_only |

Rationale: only the three roles that genuinely execute (Developer, Tester, Operations) get
`shell`; Finance is fully read-only-ish (no shell/git/network); every role is `ask` on
filesystem so nothing is written without a bird; the six read-mostly roles ask on every action.

## 5. Model & provider (approved)

All ten houses use:

- `executionProvider: "opencode"` (the path that actually executes on this machine)
- `aiProvider: "ollama-cloud"`
- `modelId: "deepseek-v4.1-flash"`

Verified against the live OpenCode store (42 sessions use exactly
`{"id":"deepseek-v4.1-flash","providerID":"ollama-cloud"}`). No house is set to the direct
Ollama provider, because there is no local Ollama server to run them.

## 6. Single source of truth & delivery mechanism (option C)

To guarantee houses and templates can never drift, both are derived from **one** constant.

### 6.1 `DEFAULT_HOUSES` in `src/shared/constants.ts`

A new `readonly DefaultHouse[]`, one entry per roster row, each carrying:

```ts
interface DefaultHouse {
  house: { name: string; description: string };
  agent: { name: string; role: string };
  configuration: {
    systemPrompt: string;
    executionProvider: "opencode";
    aiProvider: "ollama-cloud";
    modelId: "deepseek-v4.1-flash";
    workspaceAllowlist: string[];       // [] — user fills in real dirs per house
    tools: string[];
    permissions: { fileSystem; shell; network; git };
    approvalPolicy: "always" | "risky_only";
    concurrency: 1;
  };
}
```

Each `systemPrompt` is role-specific, written in the house's ACOTAR voice (e.g. Helion the
spell-cleaver for the developer; Azriel the Shadowsinger for the tester who finds what is
hidden), and states the agent's function, working style, and constraints plainly so the model
behaves usefully. Prompts are editable later via the standard house form.

### 6.2 Seeding real houses — `seedDefaultHouses(db)`

A new idempotent seeder in `src/server/repositories/house-repo.ts`, modelled on
`seedHighLordHouse`:

- For each `DEFAULT_HOUSES` entry, **insert only if no house with that `name` exists**
  (`SELECT id FROM houses WHERE name = ?`), mirroring the provider-config/template seed style.
- Inserts house + agent + `agent_configurations` in one transaction with `kind = 'agent'`,
  `status = 'active'`.
- **Never clobbers user edits**: an existing house with the same name is skipped untouched.
- Accepts either the Drizzle wrapper or the raw connection (so the engine can call it).
- Returns the number inserted.

Called from both boot paths, alongside the existing seeds:
- `src/server/bootstrap.ts` — after `seedHighLordHouse`
- `src/engine/main.ts` — after its existing seeds

### 6.3 Derived templates — `replace-and-clean` (approved)

The ten houses are **also** exposed as house templates so they are re-instantiable.

- `DEFAULT_TEMPLATES` is regenerated: the ten new house templates are **derived from
  `DEFAULT_HOUSES`** (name, description, and a payload matching `houseTemplatePayloadSchema`:
  `agent` + `configuration`, no `name`), plus the existing project template(s).
- The three superseded seeded house templates (`Research House`, `Engineering House`,
  `Docs House`) are **removed from the defaults**, and a one-time cleanup deletes the
  `is_seeded = 1` house templates that are no longer in the default set, so the user ends with
  exactly the ten derived house templates. User-created templates are **never** deleted.
- Cleanup is idempotent and keyed on `is_seeded = 1` AND the template name NOT being in the
  current default set. It must be safe to run on every boot.
- Seeded templates remain **immutable** (existing 409 behaviour) and are never clobbered.

The derived-template payload must be byte-compatible with the same zod schemas direct house
creation uses, so instantiation produces a fully configured house.

## 7. Architecture / data flow

```
src/shared/constants.ts
  DEFAULT_HOUSES ──┬──> seedDefaultHouses()  ──> houses + agents + agent_configurations  (boot, web + engine)
                   └──> DEFAULT_TEMPLATES (derived) ──> seedDefaultTemplates() + cleanup   (boot, web + engine)
```

- No schema change and therefore **no migration**.
- No new API routes and no new UI: seeding is boot-time; templates use the existing picker
  and Settings manager.
- Layering preserved: constants are shared data; seeding lives in repositories; boot calls come
  from `bootstrap.ts`/`engine/main.ts`.

## 8. Map behaviour

After seeding, the city has twelve castles: **High Lord pinned at the centre (gold)**, with
the ten role houses plus House of Wind spreading outward in rings via the existing spiral
layout. All ten are intentionally **visible** (approved) — visible departments are the point.
The layout already handles arbitrary house counts.

## 9. Testing

**Unit / integration (Vitest):**
- `seedDefaultHouses` inserts exactly ten on a fresh DB; a second run inserts zero (idempotent).
- **No-clobber**: edit a seeded house (rename an agent / change a permission), re-run the
  seeder, assert the edit survives and no duplicate is created.
- **Roster integrity**: every `DEFAULT_HOUSES` entry has one agent and a complete
  configuration; all ten names are unique; all use `deepseek-v4.1-flash`.
- **Derivation**: the derived house templates match `DEFAULT_HOUSES` one-for-one
  (name + payload), and every derived payload parses against `houseTemplatePayloadSchema`.
- **Cleanup**: seeded templates no longer in the default set are removed; user-created
  templates and the project template survive; cleanup is idempotent.
- High Lord and House of Wind are untouched by seeding and cleanup.
- `constants` parity: ten house templates + project template(s) are exactly what the seeder
  writes.

**E2E (Playwright):** the ten houses appear on the houses list and the map; a quest can be
targeted at a specific house/agent.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Seeding surprises an existing user (10 new houses appear) | This is the explicit request; seeding is insert-only and namespaced by house name; documented in README. |
| Cleanup deletes something the user wanted | Cleanup only touches `is_seeded = 1` rows whose name is absent from the current default set; user-created templates are never touched; covered by a test. |
| Prompt/config drift between houses and templates | Both derive from a single `DEFAULT_HOUSES` constant; a test asserts one-for-one parity. |
| Too many castles / map crowding | Accepted and intentional; the spiral layout scales to arbitrary counts. |
| Model id wrong → nothing runs | Id verified against the live OpenCode store; asserted in a unit test. |
| User edits a house, then a later phase ships a changed default | No-clobber means their edit wins; changes to defaults only affect new installs. |

## 11. Affected files (anticipated)

- `src/shared/constants.ts` — add `DEFAULT_HOUSES`; regenerate `DEFAULT_TEMPLATES` (derived).
- `src/server/repositories/house-repo.ts` — add `seedDefaultHouses`.
- `src/server/repositories/template-repo.ts` — extend `seedDefaultTemplates` with the cleanup.
- `src/server/bootstrap.ts`, `src/engine/main.ts` — call `seedDefaultHouses`.
- `src/shared/types.ts` — `DefaultHouse` type.
- Tests: `tests/unit/house-seed-defaults.test.ts`, template-seed/cleanup tests, an e2e spec.
- `README.md` — document the ten default houses and that seeding is idempotent.

## 12. Open questions

None outstanding — all decisions resolved during brainstorming:

- Roster and names: approved (with Research / Communications / Operations additions).
- Delivery: **(C)** seed real houses **and** derive templates.
- Permissions matrix: approved as tabled.
- Model/provider: `opencode` + `ollama-cloud` + `deepseek-v4.1-flash`.
- Existing seeded templates: **replace-and-clean**.
- Map: all ten **visible**.
