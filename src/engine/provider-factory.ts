/**
 * Provider factory — the engine's provider seam (Phase 5 Stage A).
 *
 * Decouples `src/engine/queue.ts` / `src/engine/runner.ts` /
 * `src/engine/orchestrator.ts` from the concrete OpenCode client so a second
 * provider (Ollama) can be added without forking the OpenCode path.
 *
 * Responsibilities:
 *  - `resolveProviderKind(house)` → the house's `configuration.executionProvider`.
 *  - `createProviderForHouse(kind, deps)` → the AgentExecutionProvider for a kind.
 *    OpenCode is wired today; the Ollama adapter lands with the Stage F runtime.
 *  - `providerHealth(kind, deps)` → honest per-provider health. OpenCode uses the
 *    client; Ollama uses the Ollama client (Stage B) — never a global gate.
 *
 * The OpenCode path here must behave byte-identically to the pre-seam code.
 */

import type Database from "better-sqlite3";
import type { VelarisDb } from "@/lib/db";
import type { AgentExecutionProvider, ProviderKind } from "@/server/execution/types";
import { createOpenCodeAdapter } from "@/server/execution/opencode/provider";
import { createOllamaAdapter } from "@/server/execution/ollama/provider";
import { OpencodeClient } from "@/server/opencode";
import { OllamaClient } from "@/server/execution/ollama/client";
import type { HouseAgentDto, HouseDto } from "@/shared/types";

/** Engine-facing deps a provider may need to be constructed / probed. */
export interface ProviderFactoryDeps {
  db?: VelarisDb;
  raw?: Database.Database;
  client?: OpencodeClient;
  ollamaClient?: OllamaClient;
}

/** Resolve the provider kind for a house from its stored execution provider. */
export function resolveProviderKind(house: Pick<HouseDto, "configuration">): ProviderKind {
  return house.configuration.executionProvider;
}

/**
 * Resolve the provider kind for a ROUTED agent. When the queue picks a
 * non-default agent for a task, that agent's configuration drives provider
 * dispatch (Phase 6 Stage B). With no agent (or the default agent, whose
 * config === house.configuration) this is identical to `resolveProviderKind`.
 */
export function resolveProviderKindForAgent(
  agent: Pick<HouseAgentDto, "configuration"> | null | undefined,
  house: Pick<HouseDto, "configuration">,
): ProviderKind {
  return (agent?.configuration ?? house.configuration).executionProvider;
}

/** Build the AgentExecutionProvider for a provider kind.
 *
 * OpenCode is fully wired (`createOpenCodeAdapter`); Ollama wires the native
 * tool-loop adapter (`createOllamaAdapter`) that runs the Stage F runtime. */
export function createProviderForHouse(
  kind: ProviderKind,
  deps: ProviderFactoryDeps,
): AgentExecutionProvider {
  switch (kind) {
    case "opencode":
      if (!deps.client) {
        throw new Error("provider-factory: opencode requires an OpencodeClient");
      }
      return createOpenCodeAdapter({ client: deps.client, db: deps.db! });
    case "ollama":
      if (!deps.ollamaClient) {
        throw new Error("provider-factory: ollama requires an OllamaClient");
      }
      return createOllamaAdapter({ client: deps.ollamaClient, db: deps.db! });
  }
}

/** Honest per-provider health probe. Never throws (unreachable degrades to false).
 * OpenCode → client.health(); Ollama → ollamaClient.health(). */
export async function providerHealth(
  kind: ProviderKind,
  deps: ProviderFactoryDeps,
): Promise<boolean> {
  try {
    switch (kind) {
      case "opencode":
        return deps.client ? await deps.client.health() : false;
      case "ollama":
        return deps.ollamaClient ? await deps.ollamaClient.health() : false;
    }
  } catch {
    return false;
  }
}
