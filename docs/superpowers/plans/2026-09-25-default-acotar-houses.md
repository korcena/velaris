# Default ACOTAR Houses — Implementation Plan

**Date:** 2026-09-25
**Baseline:** HEAD `f965a31` ("Add design spec for default ACOTAR houses"), Phase 6.1 complete.
Working tree clean. `npx tsc --noEmit` **0** at baseline.
**Author:** planning agent (no production code written)
**Source of truth for scope:** `docs/superpowers/specs/2026-09-25-default-acotar-houses-design.md`
(the approved, frozen design). This plan does not re-litigate any design choice; it turns the
spec into ordered, file-level work grounded in the code at HEAD.

> **Small, well-specified feature.** No schema change, no new API route, no new UI, no new
> dependency. The whole feature is one shared constant, two seeders, one cleanup, boot wiring,
> README, and tests. The main *unbudgeted* risk is that seeding 10 houses on every web boot
> invalidates existing tests that assume an empty houses grid — §7 enumerates every one found.

---

## 0. Codebase verification findings (read before implementing)

| Question | Answer (verified) |
|---|---|
| Where do default templates live? | `DEFAULT_TEMPLATES` in `src/shared/constants.ts:396-471`; its interface `DefaultTemplate` in the **same file** at `constants.ts:473-478` (not `types.ts`). Payload is `Record<string, unknown>`. |
| Model/provider constants today | `DEFAULT_AI_PROVIDER = "ollama-cloud"` (`constants.ts:379`), `DEFAULT_MODEL_ID = ""` (`constants.ts:380`). High Lord seeds `glm-5.3` (`constants.ts:261`). Per the spec, each new house hardcodes `deepseek-v4.1-flash`; do **not** change either global default. |
| Permission/approval types | `Permissions`/`PermissionMode` (`types.ts:23-31`), `ApprovalPolicy` (`types.ts:33`), `HouseConfiguration` (`types.ts:36-46`). `APPROVAL_POLICIES` (`constants.ts:323`), `PERMISSION_MODES` (`constants.ts:330`), `TEMPLATE_KINDS` (`constants.ts:387`). |
| Input schemas the derived payload must satisfy | `houseConfigurationSchema` (`schemas/house.ts:37-47`), `houseAgentSchema` (`:18-21`), `houseCreateSchema` (`:89`); `houseTemplatePayloadSchema = houseCreateSchema.omit({name:true}).strict()` (`schemas/template.ts:31`). `.strict()` ⇒ payload keys must be **exactly** `{description, agent, configuration}`. `HouseTemplatePayload` type (`types.ts:504-508`). |
| Seed house pattern | `seedHighLordHouse` (`house-repo.ts:606-673`), idempotent on `kind='high_lord'`, accepts `VelarisDb \| Database.Database` via `"$client" in db` (`:609-610`), raw prepared INSERTs, **no audit**. `createHouse` (`:271-315`) defaults `kind='agent'`, `status='active'`, one transaction, requires the Drizzle wrapper. |
| Seed template pattern | `seedDefaultTemplates` (`template-repo.ts:210-228`); `normalizeRaw` (`:73-77`); idempotent by `(kind,name)`; inserts `is_seeded=1`; returns inserted count. Seeded rows are immutable via API (`SeededTemplateError`, `template-repo.ts:41`, guard `:193-198`). |
| Boot wiring | Web: `bootstrap.ts:16-26` calls migrate → `seedDefaultProviderConfigs` → `seedHighLordHouse` → `seedDefaultTemplates`, guarded once by `_done`. Engine: `engine/main.ts:65-77` calls the same two seeds after migrate. |
| "House of Wind" | **No such seeded/default entity exists.** Only test fixtures (`tests/unit/orchestrator.test.ts:187`, `plan-resolve.test.ts:45`). The spec's "never touch House of Wind" is vacuously satisfied; do not add anything for it. |
| Map visibility | `castle-map.tsx:125` fetches `/api/houses?includeArchived=true&includeHighLord=true`; layout handles arbitrary counts. No change needed. `listHouses` excludes `high_lord` unless opted in (`house-repo.ts:236-240`). |
| Existing tests coupled to the 3 seeded house templates / empty grid | See §7. These **must be updated** in Stage D or `npm test` / `npm run test:e2e` will go red. |

---

## 1. Objective

At boot, seed **ten default houses** (one ACOTAR-named agent each) with the approved
permissions/model, and expose them as **derived house templates**, all from a single
`DEFAULT_HOUSES` constant, with a one-time idempotent cleanup of the three superseded seeded
house templates. No migration, no new route/UI/dependency. High Lord and user data are never
clobbered.

## 2. NO migration (explicit)

There is **no schema change**. `houses`, `agents`, `agent_configurations`, and `templates`
already carry every column this feature writes. Therefore:

- Do **not** run `npm run db:generate`.
- Do **not** add anything to `drizzle/` or `drizzle/meta/` (no `0005_*`).
- Seeding is boot-time data only, applied by web (`bootstrap.ts`) and engine (`engine/main.ts`).

## 3. No-clobber / user-data safety (contract)

| Actor | May touch | May NEVER touch |
|---|---|---|
| `seedDefaultHouses` | `houses` rows it inserts (kind `agent`, status `active`) when **no row of any kind/status already has that exact name** | Any existing house (same name, any kind/status), High Lord (`kind='high_lord'`), agents/configs of existing houses |
| `seedDefaultTemplates` insert | `templates` rows for the 10 derived house templates + the project template(s), `is_seeded=1`, when `(kind,name)` is absent | Existing `(kind,name)` rows of any `is_seeded` value |
| cleanup (inside `seedDefaultTemplates`) | Only `templates` rows with `is_seeded = 1` **AND** `kind = 'house'` **AND** `name NOT IN <current default house-template names>` | `is_seeded = 0` (user) templates; `kind='project'` templates (including seeded `Standard Repo`); seeded house templates still in the default set |
| Never removed by this feature | — | Houses (there is no house cleanup); High Lord; project templates |

**Rules (decided):**
1. A house is considered "already present" if **any** `houses` row (any `kind`, any `status`)
   has the same exact `name`. The default is skipped; nothing is renamed/merged.
2. A user-created template that happens to share a default's `(kind,name)` blocks the seeded
   insert (seed's `exists` check is kind+name only, `template-repo.ts:212-214`) and, being
   `is_seeded=0`, is never deleted by cleanup.
3. Seeded templates stay API-immutable (409) unchanged.

---

## 4. Stages

Ordered so the tree is always green: type/constant first (compiles), seeder next (unused until
wired), wiring next, derived templates + cleanup next, tests, docs.

| Stage | Title | One-line deliverable | Files | Size |
|---|---|---|---|---|
| **A** | `DEFAULT_HOUSES` + `DefaultHouse` | Single source-of-truth roster of 10 entries | `constants.ts`, (`types.ts`) | M |
| **B** | `seedDefaultHouses` + boot wiring | Idempotent, no-clobber house seeding on both boots | `house-repo.ts`, `bootstrap.ts`, `engine/main.ts` | S–M |
| **C** | Derived `DEFAULT_TEMPLATES` + cleanup | Templates derived from houses; superseded seeds deleted | `constants.ts`, `template-repo.ts` | M |
| **D** | Tests | Spec §9 coverage + repair coupled tests | new + existing test files | M–L |
| **E** | README | Document the ten default houses | `README.md` | S |

---

### Stage A — `DEFAULT_HOUSES` constant + `DefaultHouse` type (M)

**Goal:** one literal that both seeders read, so houses and templates cannot drift.

**A.1 `DefaultHouse` type** — add to `src/shared/types.ts` per spec §11. It references
`HouseConfiguration` (already in `types.ts`), so no new imports:

```ts
export interface DefaultHouse {
  house: { name: string; description: string };
  agent: { name: string; role: string };
  configuration: HouseConfiguration; // includes systemPrompt, workspaceAllowlist, tools,
                                     // permissions, approvalPolicy, concurrency
}
```

> Precedent note: `DefaultTemplate` actually lives in `constants.ts` (not `types.ts`). Spec §11
> names `types.ts`; either location is safe (constants.ts already imports types from `./types`,
> and `types.ts` already `import type`s from `./constants`, an existing type-only cycle). See
> Open Question Q1 — recommendation is `constants.ts` to mirror `DefaultTemplate`.

**A.2 `DEFAULT_HOUSES`** — add to `src/shared/constants.ts` near `DEFAULT_TEMPLATES`:

```ts
export const DEFAULT_HOUSES: readonly DefaultHouse[] = [ /* 10 entries */ ] as const;
```

**Content (transcribe faithfully from the frozen spec — do NOT invent prompts):**

| # | House (`house.name`) | Agent | Role (`agent.role`) | tools | fileSystem/shell/network/git | approvalPolicy |
|---|---|---|---|---|---|---|
| 1 | Day Court | Helion | Spell-cleaver · software developer | `fs,shell,git` | ask/ask/ask/allow | risky_only |
| 2 | House of Shadow | Azriel | Shadowsinger · software tester | `fs,shell,git` | ask/ask/ask/allow | risky_only |
| 3 | Hewn City | Amren | The Second · software reviewer | `fs,shell,git` | ask/ask/deny/allow | always |
| 4 | The Library | Clotho | High Priestess of the Library · technical writer | `fs,git` | ask/deny/deny/allow | always |
| 5 | Court of Truth | Morrigan | Truth-bearer · analyst | `fs` | ask/deny/ask/deny | always |
| 6 | The Townhouse | Nuala | Keeper of the House · secretary | `fs,git` | ask/deny/ask/allow | always |
| 7 | Summer Court | Tarquin | High Lord of Summer · accountant | `fs` | ask/deny/deny/deny | always |
| 8 | Windhaven | Gwyn | Valkyrie archivist · researcher | `fs` | ask/deny/ask/deny | always |
| 9 | The Crossing | Lucien | Emissary · liaison | `fs` | ask/deny/ask/deny | always |
| 10 | Illyria | Cassian | General of the Armies · operations lead | `fs,shell,git` | ask/ask/ask/allow | risky_only |

For **every** entry:
- `configuration.executionProvider = "opencode"`, `aiProvider = "ollama-cloud"`,
  `modelId = "deepseek-v4.1-flash"`, `workspaceAllowlist = []`, `concurrency = 1`.
- `house.description` and `configuration.systemPrompt` are **role-specific, ACOTAR-voiced**
  prose (spec §6.1): state function, working style, and constraints plainly. Write one prompt
  per roster row using the agent's voice (e.g. Helion the spell-cleaver for development;
  Azriel the Shadowsinger for testing/hidden defects; Amren the Second for review; Clotho for
  writing the record; Gwyn for finding/synthesising; Cassian for operations). Keep each prompt
  a useful few sentences; there is no length minimum beyond the schema's non-empty rule.
- `tools` are the exact arrays in the table (order as listed); `permissions` the exact
  matrix; `approvalPolicy` per row.

**Edge cases:** all 10 names unique (unit-asserted); `workspaceAllowlist: []` is intentional
(user fills real dirs later); model differs from High Lord's `glm-5.3` — leave that untouched.

**Tests:** add roster-integrity assertions (Stage D). **Gate:** `npx tsc --noEmit`.

---

### Stage B — `seedDefaultHouses` + boot wiring (S–M)

**B.1 `src/server/repositories/house-repo.ts`** — add, modelled on `seedHighLordHouse`
(`:606-673`) and accepting the same union so the raw-engine process can call it:

```ts
export function seedDefaultHouses(db: VelarisDb | Database.Database): number
```

Behaviour:
- Normalize exactly like `seedHighLordHouse:609-610`.
- For each `DEFAULT_HOUSES` entry: `SELECT id FROM houses WHERE name = ? LIMIT 1`; skip if a
  row exists (any kind/status) — **no-clobber**.
- Insert house (`kind='agent'`, `status='active'`) + agent + `agent_configurations` in **one
  transaction**, mirroring the three raw INSERTs at `house-repo.ts:627-670`, with
  `workspace_allowlist`, `tools`, `permissions` as `JSON.stringify(...)` (matching
  `createHouse:305-307`). Use ISO timestamps for `created_at`/`updated_at`.
- Return the number inserted.
- **Do not** audit (boot seed, not a user action; matches `seedHighLordHouse`).

Implementation note (recommended): implement the per-entry insert via a private helper
`insertHouseWithAgent(raw, input)` reused by `seedHighLordHouse` only if it stays small;
otherwise duplicate the 3 statements to avoid touching High Lord behaviour. Prefer a
`.immediate()` transaction so web+engine boot seeding can't both pass the existence check and
double-insert (see Q6).

**B.2 `src/server/bootstrap.ts`** — call after High Lord, before templates (`:19-24`):

```ts
seedHighLordHouse(getRawDb());
seedDefaultHouses(getRawDb());     // NEW
seedDefaultTemplates(getRawDb());
```

Import `seedDefaultHouses` from `@/server/repositories/house-repo`.

**B.3 `src/engine/main.ts`** — same insertion at `:74-76`:

```ts
seedHighLordHouse(raw);
seedDefaultHouses(raw);            // NEW
seedDefaultTemplates(raw);
```

**Edge cases:** empty DB → inserts 10; existing houses → only missing names inserted; re-run →
0 (names exist); a user-created house named e.g. `Day Court` → that default is skipped
untouched; High Lord unaffected. **Gate:** `npx tsc --noEmit`; existing `npm test` still green
(seeder unused by tests until D, but wiring now affects integration routes — see §7).

---

### Stage C — Derived `DEFAULT_TEMPLATES` + cleanup (M)

**C.1 Derive in `src/shared/constants.ts`** — replace the 3 hardcoded house entries
(`constants.ts:397-459`) with a mapping, keeping the project entry (`Standard Repo`,
`:460-470`):

```ts
function defaultHouseToTemplate(h: DefaultHouse): DefaultTemplate {
  return {
    kind: "house",
    name: h.house.name,
    description: h.house.description,
    payload: {
      description: h.house.description,
      agent: { name: h.agent.name, role: h.agent.role },
      configuration: h.configuration,
    },
  };
}

const STANDARD_REPO_TEMPLATE: DefaultTemplate = { /* existing project entry unchanged */ };

export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  ...DEFAULT_HOUSES.map(defaultHouseToTemplate),
  STANDARD_REPO_TEMPLATE,
];
```

Result: **11** defaults = 10 derived house templates + 1 project template. The payload keys
are exactly `{description, agent, configuration}` so it parses under
`houseTemplatePayloadSchema` (`.strict()`, `schemas/template.ts:31`); instantiation then runs
`houseCreateSchema` unchanged (`template-service.ts:169-180`).

**C.2 Cleanup in `src/server/repositories/template-repo.ts`** — extend
`seedDefaultTemplates` (`:210-228`). Keying (decided): delete rows matching
`is_seeded = 1 AND kind = 'house' AND name NOT IN (<current default house-template names>)`.
Order: **insert the current defaults first, then clean** (a crash mid-seed cannot strip the
user's house templates). Keep the return type `number` (inserted); cleanup is side-effecting
and testable via the DB.

```ts
// after the insert loop, still inside seedDefaultTemplates:
const houseNames = DEFAULT_TEMPLATES.filter((t) => t.kind === "house").map((t) => t.name);
if (houseNames.length) {
  const placeholders = houseNames.map(() => "?").join(",");
  raw.prepare(
    `DELETE FROM templates
      WHERE is_seeded = 1 AND kind = 'house' AND name NOT IN (${placeholders})`,
  ).run(...houseNames);
}
```

This removes `Research House`, `Engineering House`, `Docs House` once, and is idempotent on
every subsequent boot. It cannot delete user templates (`is_seeded=0`) or project templates
(`kind='project'`). Seeded immutability (409) is untouched (`template-repo.ts:41,193-198`).

**Edge cases:** user template named like a default → survives (rule 2 in §3); already-absent
superseded seeds → no-op; fresh DB → 10 house + 1 project, no cleanup; re-run → insert 0,
delete 0. **Gate:** `npx tsc --noEmit`; `npm test` (expect the coupled-test updates from §7).

---

### Stage D — Tests (M–L)

Follow existing conventions:
- Unit DB tests: temp file + `migrate()` + `resetDbForTests()` (see `tests/unit/house-seed.test.ts:52-64`).
- Integration: set `VELARIS_DB_PATH` **before importing route modules**;
  `resetDbForTests()` + `resetBootstrapForTests()` in `beforeEach` (see
  `tests/integration/api-routes.test.ts:64-69`).
- E2E: web-only, engine **off**, `workers:1`, viewport 1280×720, shared e2e DB wiped by
  `playwright.config.ts`; seed rows directly with `better-sqlite3` when needed. Never point at
  the real `db/velaris.db`.

**D.1 New `tests/unit/house-seed-defaults.test.ts`** (spec §9):
1. Fresh DB → `seedDefaultHouses(db)` returns `10`; `listHouses(db)` has the 10 names.
2. Second run → returns `0`; total still 10.
3. No-clobber: seed, edit an agent/permission via `updateHouseService`, re-run, assert the
   edit survives and no duplicate.
4. Roster integrity: each `DEFAULT_HOUSES` entry has one agent + complete configuration; all
   10 names unique; every entry `modelId === "deepseek-v4.1-flash"`,
   `executionProvider === "opencode"`, `aiProvider === "ollama-cloud"`.
5. Raw-connection path: `seedDefaultHouses(getRawDb())` returns 10 on empty, 0 on re-run
   (mirrors `house-seed.test.ts:97-103`).
6. High Lord untouched: seed High Lord then defaults; HL still singleton/unchanged.

**D.2 Extend `tests/unit/template-repo.test.ts`** (spec §9 derivation + cleanup):
1. Derivation one-for-one: for each `DEFAULT_HOUSES` entry there is a seeded house template
   with the same name; payload `agent`/`configuration` equal the source; every derived payload
   parses under `houseTemplatePayloadSchema.parse(...)`.
2. `DEFAULT_TEMPLATES` shape: 10 house + 1 project.
3. Cleanup: pre-insert a seeded superseded house template
   (e.g. `Research House`, `is_seeded=1`) and a user template (`is_seeded=0`) and the project
   template; run `seedDefaultTemplates`; assert the superseded seeded row is gone, the user
   template + `Standard Repo` survive, and a second run deletes nothing.
4. Constants parity: the seeder writes exactly `DEFAULT_TEMPLATES` (house+project).
5. Update the existing hardcoded expectations: `:182,187,190,210` use
   `DEFAULT_TEMPLATES.length` (now 11 — already dynamic), `:237` `toHaveLength(3)` → 10, and
   `:198,208,231,236,302,307` currently use `"Research House"` — switch to a real default name
   (e.g. `"Day Court"`) and update the expected agent (`Helion`).

**D.3 Extend `tests/unit/schemas.test.ts:894-899`** — keep parity assertion; add that every
`DEFAULT_TEMPLATES` house payload parses under `houseTemplatePayloadSchema`.

**D.4 New `tests/e2e/default-houses.spec.ts`** (spec §9): with the seeded boot, assert the ten
default houses appear on `/houses` (by name) and as castles on `/map`
(`map-castle-<id>` for each); then post a quest targeted at a specific house/agent via the API
(`POST /api/tasks` with `houseId` + `agentId`) and assert it is created/visible. Do **not**
archive/delete seeded houses (they are the fixture).

**D.5 Repair existing tests that assume an empty/3-template world** (see §7). These are
required, not optional. **Gate:** `npx tsc --noEmit` → `npm test` → free port 3000 →
`npm run test:e2e`.

---

### Stage E — README (S)

In `README.md`, under "What you can do today" (near the **Found houses** / **Build from
templates** bullets, `README.md:30-63`), add a concise entry (e.g. **Meet the ten default
houses**) listing the roster (House — Agent — Function) and stating that all ten are seeded
idempotently on first boot, are editable, and are recoverable as templates. Note seeding is
idempotent and never clobbers edits. Keep it to a short table/bullet; no docs restructure.

---

## 5. Testing strategy (consolidated)

| File | Change | Covers |
|---|---|---|
| `tests/unit/house-seed-defaults.test.ts` | NEW | 10-insert, idempotent, no-clobber, roster/model integrity, raw path, HL untouched |
| `tests/unit/template-repo.test.ts` | EXTEND/REPAIR | derivation parity, schema-parse, cleanup + idempotence, user/project survival |
| `tests/unit/schemas.test.ts` | EXTEND | `DEFAULT_TEMPLATES` house payloads parse |
| `tests/integration/template-routes.test.ts` | REPAIR | sealed template name changes (seeded instantiation) |
| `tests/integration/api-routes.test.ts` | REPAIR | house list counts now include 10 seeds |
| `tests/e2e/default-houses.spec.ts` | NEW | ten houses on list + map; quest targeted at house/agent |
| `tests/e2e/house-journey.spec.ts` | REPAIR | empty-state → seeded grid |
| `tests/e2e/house-edit-dialog.spec.ts` | REPAIR | scope Edit buttons to fixtures; afterAll must not delete seeds |
| `tests/e2e/phase6-templates.spec.ts` | REPAIR | pick a real seeded house template (not `Engineering House`) |

**Gate order (standing):** `npx tsc --noEmit` → `npm test` → free port 3000 →
`npm run test:e2e`. **Never** `npm run lint`.

---

## 6. Standing gates / conventions

- `npx tsc --noEmit` must be **0** (the only typecheck gate; no lint).
- `npm test` green (unit + integration); `npm run test:e2e` green (engine off; seed rows
  directly; viewport 1280×720; `workers:1`; free port 3000 first).
- **No new dependencies / no version bumps** (AGENTS.md; prior reverts in git history).
- **No migration** — nothing added to `drizzle/`; do not run `db:generate`.
- Import boundaries: `src/shared/**` must stay React/Next-free (this is why the derivation
  helper lives in `constants.ts`); `src/app` must not import `src/engine`.
- Engine single-writer: this feature writes only `houses`/`agents`/`agent_configurations` and
  `templates` at boot, on both processes, idempotently — no execution-table writes.
- Never touch the real `db/velaris.db` in tests; E2E DB is `db/velaris-e2e.db` (wiped by the
  Playwright webServer).

---

## 7. Blast radius: existing tests coupled to the old world (verified)

Seeding 10 houses on every web boot (`bootstrapDb()` runs from every `/api/*` route) and
replacing the 3 seeded house templates breaks tests that hardcode emptiness/counts/names.
Confirmed at HEAD:

1. `tests/integration/api-routes.test.ts:269` `body.houses).toHaveLength(1)`,
   `:278` `toHaveLength(0)`, `:283` `toHaveLength(1)` — now include the 10 seeded houses. Fix:
   filter to the created house name, or assert counts relative to the seeded 10.
2. `tests/unit/template-repo.test.ts:237` `listTemplates(db,{kind:"house"})` `toHaveLength(3)`
   → 10; and the `"Research House"` references at `:198,208,231,236,302,307`.
3. `tests/integration/template-routes.test.ts:242` finds seeded `"Engineering House"`; the
   subsequent assertions (`Engineer`, `glm-5.3`, `risky_only`) must move to a real default
   (e.g. `Day Court`, `Helion`, `deepseek-v4.1-flash`, `risky_only`).
4. `tests/e2e/phase6-templates.spec.ts:24,38,63` pick `Engineering House` and assert
   `glm-5.3` — switch to a real default and update model/agent.
5. `tests/e2e/house-journey.spec.ts:27` asserts `"The city's great houses lie empty."` — no
   longer true; rewrite the empty-state step and scope the Edit/Disable/Archive buttons to the
   created house (multiple buttons now exist).
6. `tests/e2e/house-edit-dialog.spec.ts:26,37,49` use `getByRole("button",{name:"Edit"}).nth(...)`
   / `.first()` against a grid that now has 10 seeded cards; and `:59-71` `afterAll` deletes
   **every** house (`/api/houses?includeArchived=true`), which would delete the seeded houses
   and strand later specs (bootstrap is once-per-process). Fix: scope to the spec's own houses
   and delete only those by id/name.
7. `tests/integration/phase6-adversarial-routes.test.ts:226` counts houses named
   `Research House` (a *template*-instantiation tamper probe) — still correct with no such
   default house; verify it stays 0.

Run the full `npm test` + `npm run test:e2e` and repair any other global-count/index
assumptions the suite surfaces. `tests/unit/schemas.test.ts:897-898` stays valid.

---

## 8. Open Questions (short — design is settled)

> **Resolved (2026-09-25):** all six recommendations below were **accepted** (they are internal
> implementation choices consistent with existing codebase precedent, not user-facing design
> decisions). `DefaultHouse` lives in `constants.ts`; the seeder uses raw prepared INSERTs;
> cleanup is insert-then-clean keyed on `is_seeded = 1 AND kind = 'house' AND name NOT IN
> <current defaults>`; a user house name-collision is skipped, never renamed/merged/deleted;
> and check+insert is wrapped in an `.immediate()` transaction for concurrent-boot safety.
>
> **Rename consequence (accepted):** because a house is matched by its EXACT name and there is
> no seed marker (no schema change, so no migration), **renaming** a seeded house makes its
> original default name absent, and the next boot re-creates that default. The renamed house
> is preserved; the user ends up with both. Reconfiguring a seeded house in place is preserved
> (name unchanged → skipped). This is documented in the README, the `seedDefaultHouses`
> docblock, and pinned by a non-adversarial regression test.

**Q1. Where does `DefaultHouse` live: `types.ts` (spec §11) or `constants.ts` (actual
precedent)?**
→ **Recommend `constants.ts`**, directly above `DEFAULT_HOUSES`/`DEFAULT_TEMPLATES`, mirroring
`DefaultTemplate` (`constants.ts:473-478`). It is only consumed by these constants and keeps
`types.ts` free of the roster coupling. Spec §11's `types.ts` is also acceptable (a type-only
cycle already exists); pick one and be consistent. Not blocking.

**Q2. `seedDefaultHouses` internals: reuse `createHouse` vs raw INSERTs?**
→ **Recommend raw prepared INSERTs** inside one transaction, exactly like `seedHighLordHouse`
(`house-repo.ts:627-670`), because `createHouse` requires the Drizzle wrapper (`VelarisDb`)
and the engine calls the seeder with the raw connection. Keeps one code path for both boots.

**Q3. Cleanup before or after inserting the current defaults?**
→ **Recommend insert-then-clean** (both inside `seedDefaultTemplates`), so an interrupted
seed can never leave the user with zero house templates. Cleanup only removes names absent
from the current default set, so ordering is otherwise immaterial.

**Q4. Exact cleanup keying?**
→ **`is_seeded = 1 AND kind = 'house' AND name NOT IN <current default house names>`.** Never
`is_seeded=0`; never `kind='project'`; never a name still in the default set. Idempotent.

**Q5. House name collision rule (user-created house same as a default)?**
→ **Skip the default; never rename/merge/delete.** "Present" means any `houses` row (any
`kind`, any `status`) with that exact name.

**Q6. Web+engine concurrent boot could both pass the existence check and double-insert.**
→ **Recommend wrapping each seeder's check+insert in a `better-sqlite3` `.immediate()`
transaction** (write lock taken up front; `busy_timeout=5000` already set on the connection).
Cheap insurance; mirrors the existing `seedHighLordHouse` behaviour except for the lock mode.
Non-blocking.

---

## 9. Risks & mitigations (mirrors spec §10)

| Risk | Mitigation |
|---|---|
| Existing tests assume an empty grid / 3 house templates (highest actual risk) | §7 enumerates every coupled assertion; repair in Stage D before the E2E gate; run full `npm test`/`test:e2e`. |
| Seeding surprises an existing user (10 houses appear) | Explicit request; insert-only, namespaced by house name; documented in README (Stage E). |
| Cleanup deletes something the user wanted | Cleanup only `is_seeded=1` house rows absent from the default set; user + project templates exempt; dedicated unit test (D.2.3). |
| Prompt/config drift between houses and templates | Both derive from one `DEFAULT_HOUSES`; one-for-one parity + schema-parse test (D.2.1). |
| Model id wrong → nothing runs | Id from the live OpenCode store (42 sessions); asserted in D.1.4. |
| User edits a house/template, later defaults change | No-clobber: edits win; new defaults only affect absent names (houses) / deleted superseded seeds (templates). |
| Map crowding (12 castles) | Accepted and intentional; existing spiral layout scales to arbitrary counts. |
| `DEFAULT_TEMPLATES` no longer literal → harder to eyeball | Kept deterministic via a pure `defaultHouseToTemplate` map + parity test; `Standard Repo` unchanged. |
| Boot seeding race (web+engine) | Q6 `.immediate()` transaction; name/idempotent insert. |

---

## 10. Acceptance checklist

- [ ] `DEFAULT_HOUSES` has exactly the 10 approved roster rows with the spec's exact prompts,
      tools, permission matrix, `approvalPolicy`, and `opencode`/`ollama-cloud`/`deepseek-v4.1-flash`. (A)
- [ ] `seedDefaultHouses` inserts 10 on empty, 0 on re-run, never clobbers an existing
      same-named house; called from web + engine boot after `seedHighLordHouse`. (B)
- [ ] `DEFAULT_TEMPLATES` = 10 derived house templates + project template(s); payloads parse
      under `houseTemplatePayloadSchema`; instantiation produces a fully configured house. (C)
- [ ] Cleanup removes only superseded `is_seeded=1` house templates; user + project templates
      survive; idempotent. (C)
- [ ] No migration / no `drizzle/` change; no new dependency. (§2, §6)
- [ ] Spec §9 tests all present; existing coupled tests repaired; **gates green**:
      `npx tsc --noEmit` (0) → `npm test` → `npm run test:e2e`. Never `npm run lint`. (§5, §7)
- [ ] README documents the ten default houses and idempotent seeding. (E)
- [ ] High Lord (and the test-only "House of Wind" fixture) untouched. (§0)

> **Intentional coverage note (m1):** the old e2e empty-state assertion
> (`house-journey.spec.ts` asserting *"The city's great houses lie empty."*) can no longer
> hold now that boot always seeds ten houses, so direct e2e coverage of the empty-grid branch
> is gone. This is accepted, not a regression to fix: re-covering it would require a fresh
> harness that suppresses the boot seed (out of scope for this frozen design), and the branch
> itself is unchanged by this feature.
