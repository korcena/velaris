/**
 * Plan JSON parsing & normalization primitives (Phase 4 High Lord — §5.3).
 *
 * PURE module — no DB imports, fully unit-testable. Responsibilities:
 *  - `extractPlanJson`: pull a JSON object out of the planner's free-text reply
 *    (strip Markdown fences, find the first balanced `{ … }`, string/escape
 *    aware depth scan, JSON.parse).
 *  - `validatePlan`: pass the extracted JSON through `planSchema.safeParse`.
 *  - `breakCycles`: dependency hygiene — drop unknown dep ids, remove self-refs,
 *    then break any remaining cycles via Kahn's algorithm (drop an offending
 *    edge; never fail the whole plan to the user).
 *  - `capPlan`: truncate to the engine-side hard cap.
 *  - `buildFallbackPlan`: deterministic single-subtask plan for repair-exhausted
 *    or empty runs.
 *
 * The engine imports nothing but shared schema/constants from here.
 */

import { ORCHESTRATION_DEFAULTS } from "@/shared/constants";
import { planSchema, type Plan } from "@/shared/schemas/plan";

export interface PlanValidation {
  ok: boolean;
  plan?: Plan;
  error?: string;
}

/**
 * Extract the first top-level JSON object from a model reply. Handles:
 *  - Markdown fences (```json … ``` or ``` … ```)
 *  - Prose wrapped around the JSON
 *  - Nested braces via a depth counter that is string/escape-aware
 * Returns the parsed unknown, or null when no object could be parsed.
 */
export function extractPlanJson(text: string): unknown | null {
  if (!text || !text.trim()) return null;

  let candidate = text;
  const fenced = text.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1];

  const block = extractFirstBalancedObject(candidate);
  if (!block) return null;
  try {
    return JSON.parse(block) as unknown;
  } catch {
    return null;
  }
}

/** Scan for the first balanced `{ … }`, tracking string literals and escapes. */
export function extractFirstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Validate raw JSON against the plan schema. */
export function validatePlan(raw: unknown): PlanValidation {
  const res = planSchema.safeParse(raw);
  if (!res.success) {
    return { ok: false, error: formatZodIssues(res.error.issues) };
  }
  return { ok: true, plan: res.data };
}

function formatZodIssues(issues: Array<{ path?: (string | number)[]; message?: string }>): string {
  if (!issues.length) return "Invalid plan structure";
  return issues
    .slice(0, 3)
    .map((i) => `[${(i.path ?? []).join(".") || "plan"}] ${i.message ?? "invalid"}`)
    .join("; ");
}

/**
 * Dependency hygiene + cycle breaking. Drops dep ids that don't exist in the
 * plan, removes self-references, then breaks cycles via Kahn's algorithm by
 * repeatedly dropping the first offending edge from a remaining cyclic node.
 * Never throws — a cyclic plan is always reduced to a valid DAG.
 */
export function breakCycles(plan: Plan): Plan {
  const existingIds = new Set(plan.subtasks.map((s) => s.id));
  const subtasks = plan.subtasks.map((s) => ({
    ...s,
    dependsOn: Array.from(new Set(s.dependsOn.filter((d) => d !== s.id && existingIds.has(d)))),
  }));

  // Kahn's algorithm with indegree counting. When every node processes the graph
  // is a DAG; if a cycle remains, drop one offending edge and retry. Pure.
  for (;;) {
    const dependentsOf = new Map<string, Set<string>>(); // dep -> dependents
    for (const s of subtasks) dependentsOf.set(s.id, new Set());
    for (const s of subtasks) {
      for (const d of s.dependsOn) dependentsOf.get(d)!.add(s.id);
    }
    const indeg = new Map<string, number>();
    for (const s of subtasks) indeg.set(s.id, s.dependsOn.length);

    const processed = new Set<string>();
    const stack = subtasks.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
    while (stack.length) {
      const cur = stack.pop()!;
      if (processed.has(cur)) continue;
      processed.add(cur);
      const deps = dependentsOf.get(cur);
      if (deps) {
        for (const dependent of Array.from(deps)) {
          const next = (indeg.get(dependent) ?? 1) - 1;
          indeg.set(dependent, next);
          if (next === 0) stack.push(dependent);
        }
      }
    }

    if (processed.size === subtasks.length) break; // acyclic

    // Cycle remains: drop the first edge from a residual (unprocessed) node.
    const residual = subtasks.find((s) => !processed.has(s.id));
    if (!residual) break; // safeguard
    if (residual.dependsOn.length) {
      residual.dependsOn = residual.dependsOn.slice(1);
    } else {
      // Edge into the residual node from another residual peer.
      const peer = subtasks.find(
        (s) => !processed.has(s.id) && s.dependsOn.includes(residual.id),
      );
      if (peer) peer.dependsOn = peer.dependsOn.filter((d) => d !== residual.id);
      else break;
    }
  }

  return { subtasks };
}

/** Truncate a plan to at most `max` subtasks (engine-side hard cap). */
export function capPlan(plan: Plan, max: number = ORCHESTRATION_DEFAULTS.MAX_SUBTASKS): Plan {
  if (plan.subtasks.length <= max) return plan;
  return { subtasks: plan.subtasks.slice(0, max) };
}

export interface FallbackPlanInput {
  title: string;
  description?: string;
  instruction?: string;
}

/** Deterministic single-subtask fallback plan (used when repair is exhausted). */
export function buildFallbackPlan(input: FallbackPlanInput): Plan {
  const instructions = [input.instruction, input.description]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join("\n\n");
  return {
    subtasks: [
      {
        id: "s0",
        title: input.title.trim() || "Complete the instruction",
        description: input.description ?? "",
        type: "general",
        houseId: null,
        houseHints: "",
        dependsOn: [],
        instructions,
        context: {},
        artifacts: [],
        completionRequirements: "",
      },
    ],
  };
}
