/**
 * Cost estimation for Ollama runs (Phase 5 Stage H — decision Q5).
 *
 * Pure pricing helpers. The source of truth is `provider_configs.extra.modelPricing`
 * on the default Ollama provider config, seeded empty `{}` because local-Ollama
 * pricing is unknown. Per-model entries are USD-per-1M input/output tokens.
 *
 * Honest-estimate invariant: when a model has no price entry the cost is `0` but
 * it is STILL an estimate (`estimated=true`). A provider-reported-style cost is
 * NEVER claimed for Ollama — every Ollama usage row is flagged `estimated`.
 *
 * Ollama `/api/chat` returns `prompt_eval_count`/`eval_count`, which map
 * 1:1 to input/output tokens (see runtime.ts — the terminal usage record).
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

export interface TokenCounts {
  input: number;
  output: number;
}

/**
 * Parse `extra.modelPricing` from a provider-config JSON blob.
 * Tolerantly typed: malformed entries are dropped, never thrown. Returns an
 * empty map when the key is absent or malformed.
 */
export function parsePricing(extra: Record<string, unknown>): Record<string, ModelPricing> {
  const raw = extra?.modelPricing;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: Record<string, ModelPricing> = {};
  for (const [modelId, entry] of Object.entries(raw as Record<string, unknown>)) {
    const e = entry as Record<string, unknown>;
    if (!e || typeof e !== "object") continue;
    const input = Number(e.inputPer1M);
    const output = Number(e.outputPer1M);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    if (input < 0 || output < 0) continue;
    out[modelId] = { inputPer1M: input, outputPer1M: output };
  }
  return out;
}

/**
 * Estimate USD cost for a model given its token usage and the pricing table.
 * Missing model ⇒ `0` (the caller must still mark the row `estimated=true`).
 */
export function estimateCost(
  modelId: string,
  tokens: TokenCounts,
  pricing: Record<string, ModelPricing>,
): number {
  const price = pricing[modelId];
  if (!price) return 0;
  return (
    (tokens.input / 1_000_000) * price.inputPer1M +
    (tokens.output / 1_000_000) * price.outputPer1M
  );
}
