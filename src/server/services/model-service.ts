/**
 * Model listing service — backs GET /api/models (the house-config model picker).
 *
 * Proxies OpenCode's `GET /api/model` (via the engine's client) and enriches each
 * model with a human-readable provider label from `GET /api/provider`. Keeps a
 * short in-memory cache so every house-form open / dialog re-render doesn't hammer
 * the OpenCode server; a failed / unreachable server degrades to an empty list with
 * `available: false` rather than throwing.
 *
 * Layering: lives under src/server and is imported by the route only (never by
 * src/app UI components directly).
 */

import type { OpencodeClient } from "@/server/opencode";

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
let _cache: { at: number; result: ListModelsResult } | null = null;

/** Get the model list for a client, honouring the short in-memory cache. */
export async function listModels(
  client: OpencodeClient,
  providerFilter?: string | null,
): Promise<ListModelsResult> {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) {
    return _cache.result;
  }

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
    // OpenCode unreachable → graceful empty fallback (UI shows a text fallback).
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

  const result: ListModelsResult = { models: filtered, available };
  _cache = { at: now, result };
  return result;
}

/** Test helper: drop the in-memory model cache. */
export function resetModelCache(): void {
  _cache = null;
}
