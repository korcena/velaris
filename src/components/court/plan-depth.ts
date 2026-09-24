/**
 * Pure plan-depth layering helper (Phase 4 Court UI).
 *
 * Groups a plan's subtasks into lanes by dependency depth via Kahn's
 * algorithm: subtasks with no unmet deps belong to depth 0, then each
 * dependent goes one lane deeper once all its deps are placed. Parallel,
 * independent siblings share a lane row — the Court board renders each lane
 * as a row (so independents appear side by side = "runs in parallel").
 *
 * React-free so it unit-tests cleanly (tests/unit/plan-depth.test.ts).
 * Orphan deps (a dependsOn id that doesn't exist in the plan) are tolerated
 * and treated as satisfied.
 */

export interface PlanDepthNode {
  /** Stable plan-local id ("s0", "s1", ...). */
  id: string;
  /** Dependency ids (plan-local). */
  dependsOn: string[];
}

export interface DepthResult {
  /** Lanes[0..n-1]; each lane = the subtask ids at that depth, in plan order. */
  lanes: string[][];
  /** Convenience map: id → lane index (depth). */
  depthById: Record<string, number>;
}

/**
 * Compute Kahn layering for a list of subtask nodes. Returns lanes grouped by
 * depth, preserving input order within each lane. Empty input → empty lanes.
 * Never throws on orphan deps or cycles (a cycle is broken by leaving the
 * residual nodes on their best-known lane).
 */
export function computePlanDepth(nodes: PlanDepthNode[]): DepthResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthById: Record<string, number> = {};
  const lanes: string[][] = [];
  const placed = new Set<string>();

  // Remaining unplaced ids. Peel lanes: a node becomes placeable once all its
  // real deps are already placed at a strictly earlier lane.
  const remaining = new Set(nodes.map((n) => n.id));

  while (remaining.size > 0) {
    const lane: string[] = [];
    for (const id of Array.from(remaining)) {
      const node = byId.get(id)!;
      const unresolvedDeps = node.dependsOn.filter(
        (d) => byId.has(d) && !placed.has(d),
      );
      if (unresolvedDeps.length === 0) {
        lane.push(id);
      }
    }
    if (lane.length === 0) {
      // Residual cycle — dump the rest on the next lane (ordered) and stop,
      // so we never loop forever.
      lanes.push(Array.from(remaining));
      for (const id of Array.from(remaining)) depthById[id] = lanes.length - 1;
      break;
    }
    const laneIdx = lanes.length;
    lanes.push(lane);
    // Input order within the lane.
    lane.sort((a, b) => nodes.findIndex((n) => n.id === a) - nodes.findIndex((n) => n.id === b));
    for (const id of lane) {
      placed.add(id);
      remaining.delete(id);
      depthById[id] = laneIdx;
    }
  }

  return { lanes, depthById };
}
