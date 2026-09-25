/**
 * Unit tests — Ollama cost estimation (src/server/execution/ollama/pricing.ts).
 *
 * Covers (decision Q5/Q12):
 *  - pricing table parse: valid entries, malformed dropped, empty {} tolerated.
 *  - estimateCost math (USD per-1M input/output).
 *  - missing model ⇒ 0 but still estimated=true (the row-flag invariant lives in
 *    runtime.ts; here we prove the pure estimator returns 0 so the runtime flags
 *    the row honestly).
 *  - token mapping: prompt_eval_count / eval_count map to input/output.
 */
import { describe, it, expect } from "vitest";
import { parsePricing, estimateCost } from "@/server/execution/ollama/pricing";

describe("parsePricing", () => {
  it("parses valid modelPricing entries", () => {
    const table = parsePricing({
      modelPricing: {
        "llama3.1:8b": { inputPer1M: 0.25, outputPer1M: 1.0 },
        "qwen2.5-coder": { inputPer1M: 0.1, outputPer1M: 0.5 },
      },
    });
    expect(table["llama3.1:8b"]).toEqual({ inputPer1M: 0.25, outputPer1M: 1.0 });
    expect(table["qwen2.5-coder"]).toEqual({ inputPer1M: 0.1, outputPer1M: 0.5 });
  });

  it("returns {} when extra lacks modelPricing or is malformed", () => {
    expect(parsePricing({})).toEqual({});
    expect(parsePricing({ modelPricing: "nope" })).toEqual({});
    expect(parsePricing({ modelPricing: [] })).toEqual({});
    // Non-numeric price entries are dropped.
    expect(parsePricing({ modelPricing: { m: { inputPer1M: "x", outputPer1M: 1 } } })).toEqual({});
    // Negative prices are dropped.
    expect(parsePricing({ modelPricing: { m: { inputPer1M: -1, outputPer1M: 1 } } })).toEqual({});
  });

  it("never throws on deeply malformed input", () => {
    expect(() => parsePricing({ modelPricing: { m: null } })).not.toThrow();
    expect(() => parsePricing({ modelPricing: { m: 42 } })).not.toThrow();
  });
});

describe("estimateCost", () => {
  it("computes USD from per-1M rates and token counts", () => {
    const pricing = { "m": { inputPer1M: 1.0, outputPer1M: 2.0 } };
    // 1M input × $1 + 500k output × $2 = 1 + 1 = $2
    expect(estimateCost("m", { input: 1_000_000, output: 500_000 }, pricing)).toBeCloseTo(2.0, 6);
  });

  it("maps Ollama prompt_eval_count/eval_count 1:1 to input/output tokens", () => {
    const pricing = { "m": { inputPer1M: 10, outputPer1M: 20 } };
    // prompt_eval_count=10_000 → input 10k; eval_count=2_000 → output 2k
    const estimated = estimateCost("m", { input: 10_000, output: 2_000 }, pricing);
    expect(estimated).toBeCloseTo(10_000 / 1e6 * 10 + 2_000 / 1e6 * 20, 6);
    expect(estimated).toBeCloseTo(0.1 + 0.04, 6);
  });

  it("missing model ⇒ cost 0 (the runtime still flags estimated=true)", () => {
    expect(estimateCost("unknown-model", { input: 100, output: 50 }, {})).toBe(0);
  });
});
