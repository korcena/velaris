/**
 * Model listing service — backs GET /api/models (the house-config model picker).
 *
 * Provider-aware (Phase 5 decision Q8):
 *  - providerId='opencode' (default): proxies OpenCode `GET /api/model`, enriched
 *    with a human-readable provider label from `GET /api/provider`.
 *  - providerId='ollama': sources from Ollama `GET /api/tags` (OllamaClient.
 *    listModels()). These are plain model ids with `providerId='ollama'`.
 *  - Any provider: the house form keeps a free-text fallback so house creation
 *    works with NO server running (available:false → UI shows text input).
 *
 * Keeps a short in-memory cache so every house-form open / re-render doesn't
 * hammer the server; a failed / unreachable server degrades to an empty list
 * with `available: false` rather than throwing.
 *
 * Layering: lives under src/server and is imported by the route only.
 */

import type { OpencodeClient } from "@/server/opencode";
import type { OllamaClient } from "@/server/execution/ollama/client";

/** A model entry the UI can render in a picker. */
export interface ModelDto {
  id: string;
  providerId: string | null;
  providerName: string | null;
  modelId: string;
  displayName: string;
}

export interface ListModelsResult {
  models: ModelDto[];
  available: boolean;
}

const CACHE_TTL_MS = 30_000;
let _cache: { at: number; provider: string; result: ListModelsResult } | null = null;

/** Provider dispatch — OpenCode by default, Ollama when providerId='ollama'. */
export async function listModels(
  client: OpencodeClient,
  providerFilter?: string | null,
  ollamaClient?: OllamaClient | null,
): Promise<ListModelsResult> {
  const provider = providerFilter === "ollama" ? "ollama" : "opencode";
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS && _cache.provider === provider) {
    return _cache.result;
  }
  const result =
    provider === "ollama"
      ? await listOllamaModels(ollamaClient)
      : await listOpencodeModels(client, providerFilter);
  _cache = { at: now, provider, result };
  return result;
}

/** OpenCode model list (existing behavior, provider-filtered after enrichment). */
async function listOpencodeModels(
  client: OpencodeClient,
  providerFilter?: string | null,
): Promise<ListModelsResult> {
  let rawModels: Array<{ id: string; providerID: string }> = [];
  let providerNames = new Map<string, string>();
  let available = false;

  try {
    rawModels = await client.listModels();
    available = true;
    try {
      const providers = await client.listProviders();
      providerNames = new Map(
        providers.providers
          .filter((p) => p.id)
          .map((p) => [p.id as string, typeof p.name === "string" && p.name ? (p.name as string) : (p.id as string)]),
      );
    } catch {
      // Provider enrichment is best-effort; fall back to ids as labels.
    }
  } catch {
    available = false;
    rawModels = [];
    providerNames = new Map();
  }

  const models: ModelDto[] = rawModels.map((m) => {
    const providerId = typeof m.providerID === "string" ? m.providerID : null;
    const providerName = providerId ? (providerNames.get(providerId) ?? providerId) : null;
    return {
      id: m.id,
      providerId,
      providerName,
      modelId: m.id,
      displayName: m.id && providerName && providerName !== m.id ? `${providerName}/${m.id}` : m.id,
    };
  });

  const filtered = providerFilter
    ? models.filter((m) => m.providerId === providerFilter)
    : models;
  return { models: filtered, available };
}

/** Ollama model list — GET /api/tags → plain model ids tagged providerId='ollama'. */
async function listOllamaModels(ollamaClient?: OllamaClient | null): Promise<ListModelsResult> {
  if (!ollamaClient) return { models: [], available: false };
  try {
    const names = await ollamaClient.listModels();
    const models: ModelDto[] = names.map((id) => ({
      id,
      providerId: "ollama",
      providerName: "Ollama",
      modelId: id,
      displayName: id,
    }));
    return { models, available: true };
  } catch {
    return { models: [], available: false };
  }
}

/** Test helper: drop the in-memory model cache. */
export function resetModelCache(): void {
  _cache = null;
}
