# Velaris

Velaris is a fantasy-inspired AI agent orchestration platform — a full-stack local-first web
app where you create AI agents as "houses" in a night-lit city, send them quests, watch them
work in real time, and respond to messenger birds when they need your approval. Execution is
real: agents run through [OpenCode](https://opencode.ai) (execution engine) with models
supplied by Ollama (via OpenCode's authenticated `ollama-cloud` provider, or any Ollama HTTP
endpoint).

## Documentation

- [Implementation Plan](./docs/IMPLEMENTATION_PLAN.md) — phased plan, environment findings, MVP acceptance journey, risk register
- [Architecture](./docs/ARCHITECTURE.md) — system diagram, stack, process model, database schema, API surface, design system
- [Agent Orchestration](./docs/AGENT_ORCHESTRATION.md) — execution lifecycle, provider adapter, event mapping, house status machine, messenger birds, High Lord

## Status

Phase 1 (Foundation) — not yet implemented. See the implementation plan for scope.

## Setup (placeholder — lands with Phase 1)

```bash
npm install
npm run db:migrate   # apply SQLite migrations
npm run dev          # starts web (:3000) + Velaris Engine via concurrently
```

Requirements: Node 20+, `opencode` on PATH (v1.18.31 verified). SQLite is the only datastore —
no PostgreSQL or Docker needed.