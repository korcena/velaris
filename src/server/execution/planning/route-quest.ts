/**
 * Quest auto-assignment — house resolution for a directly-posted, house-less
 * quest (design 2026-09-27).
 *
 * PURE with respect to the database: the caller passes the full roster and the
 * per-house effective workspace allowlists. The only side effect is the
 * filesystem existence check inside `isPathAllowed` (realpath), which is
 * DB-free.
 *
 * Rule:
 *  1. candidates = active agent houses (same predicate as `resolvePlan`).
 *  2. Workspace-viability filter BEFORE scoring. This MUST mirror the queue's
 *     `resolveWorkspace` exactly, per candidate house `h`:
 *       - `emptyHouseAllowlist = h.configuration.workspaceAllowlist.length === 0`
 *       - `effective = effectiveAllowlists.get(h.id) ?? []`
 *       - `D = signal.workingDirectory ?? (emptyHouseAllowlist ? signal.projectDirectory : null)`
 *       - viable iff `D != null ? isPathAllowed(D, effective)
 *                              : (!emptyHouseAllowlist && effective.length > 0
 *                                 && isPathAllowed(effective[0], effective))`
 *     i.e. the task's own project directory is only consulted for an empty
 *     *house* allowlist, and a null directory requires a non-empty house
 *     allowlist whose FIRST entry is itself resolvable — mirroring
 *     `resolveWorkspace`'s `fallback && isPathAllowed(fallback, effectiveAllowlist)`
 *     guard (a non-empty allowlist whose first entry does not exist on disk
 *     would otherwise route-then-fail). An empty house allowlist with no working
 *     directory and no project is NOT viable — the default Quest Board flow
 *     therefore escalates instead of route-then-fail.
 *
 *     Assumption: the filter reads `h.configuration` (the house default
 *     workspace allowlist). That equals the resolved runtime agent's
 *     configuration because a house-less quest cannot carry a `task.agentId`
 *     (the API enforces `agentId ⇒ houseId`), so the runtime agent is always the
 *     house default.
 *  3. Score the survivors with the existing `scoreHouse` heuristic.
 *  4. Route iff the top score is `>= QUEST_ROUTING_DEFAULTS.MIN_ROUTE_SCORE`
 *     and its margin over the runner-up is `>= MIN_SCORE_MARGIN`. Ties are
 *     stable to the input (roster) order.
 *  5. Otherwise escalate to the active High Lord when one exists and a
 *     directory is resolvable; terminal reasons `no_high_lord` / `no_directory`
 *     otherwise.
 *
 * `houses` may include the High Lord; only `kind === 'agent'` candidates are
 * scored, while the High Lord is the escalation destination.
 *
 * No DB, no Next.js/React imports.
 */

import { QUEST_ROUTING_DEFAULTS } from "@/shared/constants";
import type { HouseDto } from "@/shared/types";
import { isPathAllowed } from "@/lib/paths";
import { scoreHouse } from "./resolve-plan";

/** Why `chooseQuestHouse` reached its decision. */
export type RoutingReason =
  | "scored"
  | "no_agent_houses"
  | "weak_match"
  | "no_match"
  | "no_high_lord"
  | "no_directory";

export interface RoutingDecision {
  /** Chosen agent house, the High Lord on escalation, or null on terminal failure. */
  houseId: string | null;
  /** true ⇒ re-home onto the High Lord. */
  escalated: boolean;
  reason: RoutingReason;
  /** Best match score (0 when no candidates). */
  score: number;
}

/** The task fields that feed routing/scoring. */
export interface QuestSignal {
  title: string;
  type: string;
  description: string;
  workingDirectory: string | null;
  /**
   * The task's own project directory (`projectDirectoryForTask`), or null.
   * Only consulted when the candidate house has an empty allowlist, mirroring
   * the queue's `resolveWorkspace`.
   */
  projectDirectory: string | null;
}

/**
 * Decide whether a house-less quest routes to an agent house, escalates to the
 * High Lord, or terminates. Pure (see module docblock).
 */
export function chooseQuestHouse(
  signal: QuestSignal,
  houses: HouseDto[],
  effectiveAllowlists: Map<string, string[]>,
): RoutingDecision {
  const activeAgents = houses.filter(
    (h) => h.status === "active" && h.kind === "agent",
  );

  // Workspace-viability filter — before scoring, so a house that would fail at
  // claim never routes or counts toward the margin. Mirrors `resolveWorkspace`:
  // the project directory only applies to an empty *house* allowlist, and a null
  // directory requires a non-empty house allowlist whose first entry is itself
  // resolvable — the `fallback && isPathAllowed(fallback, …)` guard.
  //
  // Reads `h.configuration` (the default agent) rather than resolving the runtime
  // agent: valid because a house-less quest cannot carry a `task.agentId` (the API
  // enforces `agentId ⇒ houseId`), so the runtime agent is always the house default.
  const candidates = activeAgents.filter((h) => {
    const emptyHouseAllowlist = h.configuration.workspaceAllowlist.length === 0;
    const effective = effectiveAllowlists.get(h.id) ?? [];
    const dir =
      signal.workingDirectory ??
      (emptyHouseAllowlist ? signal.projectDirectory : null);
    if (dir != null) return isPathAllowed(dir, effective);
    return (
      !emptyHouseAllowlist &&
      effective.length > 0 &&
      isPathAllowed(effective[0], effective)
    );
  });

  const scores = candidates
    .map((h, index) => ({
      h,
      index,
      score: scoreHouse(
        { houseHints: signal.description, type: signal.type, title: signal.title },
        h,
      ),
    }))
    // Score DESC, stable to the input (roster) order.
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const best = scores[0];
  const runnerUpScore = scores[1]?.score ?? 0;

  if (
    best &&
    best.score >= QUEST_ROUTING_DEFAULTS.MIN_ROUTE_SCORE &&
    best.score - runnerUpScore >= QUEST_ROUTING_DEFAULTS.MIN_SCORE_MARGIN
  ) {
    return {
      houseId: best.h.id,
      escalated: false,
      reason: "scored",
      score: best.score,
    };
  }

  // Escalation. Reason first: "no agent houses at all" is distinct from "the
  // roster had candidates but the workspace filter removed them all".
  let reason: RoutingReason;
  if (activeAgents.length === 0) {
    reason = "no_agent_houses";
  } else if (!best || best.score === 0) {
    reason = "no_match";
  } else {
    reason = "weak_match";
  }

  const hl = houses.find((h) => h.kind === "high_lord" && h.status === "active");
  if (!hl) {
    return { houseId: null, escalated: false, reason: "no_high_lord", score: best?.score ?? 0 };
  }

  // A4 (documented limitation): mirrors the orchestrator's `planningDirectory`
  // — `task.workingDirectory ?? hl.configuration.workspaceAllowlist[0] ?? ""`.
  // The project registry is deliberately NOT consulted here; a projectId-only
  // quest with neither still terminates as `no_directory` (follow-up).
  const planningDirectory =
    signal.workingDirectory ?? hl.configuration.workspaceAllowlist[0] ?? "";
  if (!planningDirectory) {
    return { houseId: null, escalated: false, reason: "no_directory", score: best?.score ?? 0 };
  }

  return { houseId: hl.id, escalated: true, reason, score: best?.score ?? 0 };
}
