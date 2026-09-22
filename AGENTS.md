# AGENTS.md

Local-first AI agent orchestration app (Next.js 15 web + separate "Velaris Engine" Node process sharing one SQLite file). Single package, not a monorepo.

## Commands

```bash
npm run dev            # web (:3000) + engine together (scripts/dev.js — custom spawner, not concurrently)
npm run dev:web        # web only (what Playwright e2e boots)
npm run dev:engine     # engine only (tsx src/engine/main.ts)

npx tsc --noEmit       # typecheck — there is NO typecheck script; this is the gate
npm test               # vitest (unit + integration)
npx vitest run <file>  # single test file
npm run test:e2e       # playwright (boots its own dev:web on :3000)

npm run db:generate    # after editing src/lib/db/schema.ts → writes to drizzle/ (commit these)
npm run db:migrate     # apply migrations manually (also auto-runs on web/engine boot)
```

**Do not run `npm run lint`.** No ESLint config exists; `next lint` opens an interactive setup prompt (and is deprecated in Next 16). Verification order: `npx tsc --noEmit` → `npm test` → `npm run test:e2e` if UI/routes changed.

**Do not bump dependency versions unprompted** — a previous agent's version bumps were reverted (see git log).

## Architecture

Two processes, one package, one SQLite file (WAL, `busy_timeout=5000`):

- **Web** (`src/app`): Next App Router pages + `/api/*` routes. Never runs agent tasks. Reads execution state; writes only user-action rows (houses, projects, tasks) plus the one execution-adjacent write: approval replies in `src/app/api/approvals/[id]/respond/route.ts`.
- **Engine** (`src/engine/main.ts`, plain Node via tsx): task queue, OpenCode server lifecycle (`opencode serve --port 4096` — requires `opencode` on PATH), SSE ingestion. **Single writer** for `execution_sessions`, `execution_events`, `approval_requests` transitions, `notifications`.

Import boundaries (review convention, not lint-enforced):
- `src/shared/**` must have no Next.js or React imports (used by both processes).
- `src/app` must not import `src/engine`; engine must not import Next server utilities.
- Layering: `src/app/api/*` routes → `src/server/{repositories,services,api-helpers}` → `src/lib/db`. Zod schemas in `src/shared/schemas` are the single source for API input validation.

Real-time: browser ↔ web is SSE at `/api/stream`, driven by polling `execution_events WHERE id > lastSeenId` (integer autoincrement = cursor). Engine ↔ OpenCode is HTTP + SSE.

## Database

- Schema: `src/lib/db/schema.ts` (all Drizzle tables). Migrations in `drizzle/` are committed; `db/*.db` files are gitignored.
- Path from `VELARIS_DB_PATH` env, default `./db/velaris.db`, resolved against CWD (project root for npm scripts).
- Boot is self-migrating: web (`src/server/bootstrap.ts`) and engine both run idempotent migrate + seed. You usually don't need `db:migrate` in dev.
- Enums/CHECK constraints in schema mirror `src/shared/constants.ts` — update both together. Trust code/constants over `docs/ARCHITECTURE.md`, which lags (e.g. status names differ).

## Testing quirks

- Vitest globs: `src/**/*.test.ts`, `tests/unit/**`, `tests/integration/**`. Environment is `node` (no jsdom). 15s timeout.
- Integration tests call route handlers directly with `new Request()` — no server. DB isolation contract (see `tests/integration/api-routes.test.ts`): set `VELARIS_DB_PATH` to a temp file **before importing route modules**, and call `resetDbForTests()` + `resetBootstrapForTests()` in `beforeEach`.
- E2E: sequential, `workers: 1`, shared DB. The Playwright `webServer` **deletes `db/velaris-e2e.db`** and boots `dev:web` with `VELARIS_DB_PATH` overridden — never point it at your real DB, and free port 3000 first (`reuseExistingServer: false`).
- E2E does **not** start the engine; tests cover the web/UI only. External OpenCode/Ollama calls are mocked — keep it that way for determinism.

## Environment

Copy `.env.example` → `.env.local` (gitignored). Key vars: `VELARIS_DB_PATH`, `VELARIS_PORT`, `OPENCODE_BASE_URL` (default `http://127.0.0.1:4096`), `OLLAMA_BASE_URL`.

## Docs

`docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/AGENT_ORCHESTRATION.md` explain design intent, but some content (phase status, status enums, `concurrently`) is stale — verify against code before following.
