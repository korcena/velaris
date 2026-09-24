/**
 * House resolution for plan subtasks (Phase 4 High Lord — §5.3).
 *
 * PURE module given inputs. Takes the available (active, agent-kind) houses
 * plus the raw plan and resolves each subtask to a destination house:
 *
 *  1. Explicit `houseId` if it is valid, active, and `kind === 'agent'` (a High
 *     Lord destination is always rejected — a subtask can never name the High
 *     Lord).
 *  2. Else hint scoring: case-insensitive substring overlap of the subtask's
 *     `houseHints` + `type` against each house's name / description / role.
 *     Best score wins; ties break by list order.
 *  3. If no house scores > 0, the subtask is unresolved (the orchestrator uses
 *     the single-house fallback when NO house is resolvable at all).
 *
 * No DB access — the caller passes the roster as `HouseDto[]`.
 */

import { ORCHESTRATION_DEFAULTS } from "@/shared/constants";
import type { HouseDto } from "@/shared/types";
import type { Plan } from "@/shared/schemas/plan";
import { capPlan, breakCycles } from "./parse";

/** A subtask after house resolution (plan id + destination house id or null). */
export interface ResolvedSubtask {
  planId: string;
  title: string;
  description: string;
  type: string;
  houseHints: string;
  dependsOn: string[];
  instructions: string;
  context: Record<string, unknown>;
  artifacts: string[];
  completionRequirements: string;
  /** Resolved destination house id, or null when no eligible house matched. */
  houseId: string | null;
}

export interface ResolvedPlan {
  subtasks: ResolvedSubtask[];
}

/**
 * Score how well a subtask's hints match a house. Case-insensitive substring
 * overlap against house name, description and agent.role (plus the subtask
 * type as an extra signal). Pure.
 */
export function scoreHouse(subtask: {
  houseHints?: string;
  type?: string;
  title: string;
}, house: HouseDto): number {
  const target = [subtask.houseHints ?? "", subtask.type ?? "", subtask.title]
    .join(" ")
    .toLowerCase();
  if (!target.trim()) return 0;

  const corpus = [
    house.name,
    house.description ?? "",
    house.agent.role,
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const word of target.split(/\s+/).filter(Boolean)) {
    if (word.length < 3) continue;
    if (corpus.includes(word)) score += 1;
  }
  return score;
}

/**
 * Resolve every subtask in a normalized (cycle-broken, capped) plan to a
 * destination house. Returns a list of resolved subtasks in the same order.
 * A subtask whose explicit houseId is invalid/inactive/a-High-Lord falls back
 * to hint scoring; a subtask that matches no house gets `houseId: null`.
 */
export function resolvePlan(plan: Plan, houses: HouseDto[]): ResolvedPlan {
  const activeAgents = houses.filter(
    (h) => h.status === "active" && h.kind === "agent",
  );
  const byId = new Map(activeAgents.map((h) => [h.id, h]));

  const subtasks = plan.subtasks.map((s) => {
    // Explicit house preference — only honored if it resolves to an eligible
    // active agent house. High Lord destinations are always rejected.
    let houseId: string | null = null;
    if (s.houseId && byId.has(s.houseId)) {
      houseId = s.houseId;
    } else {
      // Hint scoring across the roster; a zero-scoring subtask falls back to
      // the first eligible house (single-house fallback, plan §5.3) so a plan
      // never stalls on an unassigned subtask.
      let best: HouseDto | null = null;
      let bestScore = 0;
      for (const h of activeAgents) {
        const sc = scoreHouse(s, h);
        if (sc > bestScore) {
          bestScore = sc;
          best = h;
        }
      }
      houseId = (best ?? activeAgents[0] ?? null)?.id ?? null;
    }

    return {
      planId: s.id,
      title: s.title,
      description: s.description ?? "",
      type: s.type ?? "general",
      houseHints: s.houseHints ?? "",
      dependsOn: s.dependsOn ?? [],
      instructions: s.instructions ?? "",
      context: s.context ?? {},
      artifacts: s.artifacts ?? [],
      completionRequirements: s.completionRequirements ?? "",
      houseId,
    };
  });

  return { subtasks };
}

/**
 * Full normalize pipeline: clean deps (breakCycles) → cap → resolve houses.
 * Convenience wrapper used by the orchestrator.
 */
export function normalizePlan(
  plan: Plan,
  houses: HouseDto[],
  maxSubtasks: number = ORCHESTRATION_DEFAULTS.MAX_SUBTASKS,
): ResolvedPlan {
  const cleaned = breakCycles(plan);
  const capped = capPlan(cleaned, maxSubtasks);
  return resolvePlan(capped, houses);
}
