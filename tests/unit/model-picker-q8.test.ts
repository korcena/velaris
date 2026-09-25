/**
 * Adversarial — model picker (Q8) and High Lord guard (Q9) non-happy paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listModels, resetModelCache } from "@/server/services/model-service";
import type { OllamaClient } from "@/server/execution/ollama/client";

describe("GET /api/models backed listModels — Q8 Ollama sourcing", () => {
  beforeEach(() => resetModelCache());

  it("sources from Ollama listModels() when providerId=ollama (mocked tags)", async () => {
    const ollama = {
      listModels: vi.fn(async () => ["llama3.1:8b", "qwen2.5-coder:7b"]),
      health: vi.fn(async () => true),
    } as unknown as OllamaClient;
    const oc = { health: vi.fn(async () => true) } as never;
    const res = await listModels(oc as never, "ollama", ollama);
    expect(res.available).toBe(true);
    expect(res.models.map((m) => m.id)).toEqual(["llama3.1:8b", "qwen2.5-coder:7b"]);
    expect(res.models.every((m) => m.providerId === "ollama")).toBe(true);
  });

  it("degrades gracefully (available:false) when Ollama is down — keeps free-text fallback", async () => {
    const ollama = {
      listModels: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
      health: vi.fn(async () => false),
    } as unknown as OllamaClient;
    const oc = { health: vi.fn(async () => true) } as never;
    const res = await listModels(oc as never, "ollama", ollama);
    expect(res.available).toBe(false);
    expect(res.models).toEqual([]); // UI shows free text
  });
});
