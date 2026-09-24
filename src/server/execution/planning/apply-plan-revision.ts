/**
 * Plan revision algorithm (addendum D2d) — pure module.
 *
 * Given the CURRENT subtask rows (as SubtaskDto[]) and a PARSED revision Plan
 * (plan ids r0, r1, … distinct from original s0, s1, …), compute a revision
 * that the orchestrator applies inside one transaction:
 *
 *  - MATCH by normalized title (trimmed, case-insensitive). Plan-local ids are
 *    not stable across revisions; titles are the only user-meaningful key.
 *  - a matched subtask that is still 'planned' | 'ready' → REWRITE in place
 *    (instructions/context/completionRequirements/houseId/dependsOn/orderIndex).
 *    In-flight/delegated matched subtasks are advisory-only: keep the delegated
 *    child untouched, do not re-delegate.
 *  - an unmatched existing subtask that is 'planned' | 'ready' → CANCELLED
 *    (it was never delegated).
 *  - unmatched existing subtasks that are 'delegated' | 'in_flight' | terminal
 *    are UNTOUCHED — in-flight work keeps running and its result lands.
 *  - new revision subtasks → CREATE, status 'planned'.
 *
 * The applier returns an explicit diff (`added`, `cancelled`, `changed`) so the
 * orchestrator can emit the Court event and the caller applies the mutations.
 *
 * Deps of new subtasks referencing matched subtasks' plan ids are normalized
 * against the POST-revision id set; a new subtask may depend on a kept subtask.
 *
 * Pure — no DB imports.
 */

import type { SubtaskDto, SubtaskStatus } from "@/shared/types";
import type { Plan } from "@/shared/schemas/plan";

export interface RevisionMutation {
  kind: "rewrite" | "cancel" | "create";
  /** For rewrite: existing subtask id; for cancel: existing subtask id; for create: new id. */
  id: string;
  planId: string;
  title: string;
  instructions?: string;
  completionRequirements?: string;
  /** Resolved destination house id (null → re-resolve at delegation). */
  houseId?: string | null;
  dependsOn?: string[];
  orderIndex?: number;
  context?: Record<string, unknown>;
  artifacts?: string[];
  description?: string;
  type?: string;
}

export interface PlanRevision {
  mutations: RevisionMutation[];
  /** Revision subtasks that cannot be applied because the existing matched
   * subtask is already delegated/in_flight and cannot be rewritten (advisory). */
  advisoryOnly: Array<{ planId: string; title: string }>;
  added: string[]; // plan ids
  cancelled: string[]; // existing subtask ids
  changed: string[]; // existing subtask ids
  /** Effective subtask set the orchestrator should reconcile (existing kept +
   * newly created plan ids). Used for edge normalization. */
  resultPlanIds: string[];
}

function normTitle(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Compute the revision against the current subtask DTOs (ordered by order_index).
 * `houses` is not needed here — resolution is delegated to resolve-plan at
 * delegation time; houseId is carried through on rewrites only if re-resolved.
 */
export function computePlanRevision(current: SubtaskDto[], revision: Plan): PlanRevision {
  const mutations: RevisionMutation[] = [];
  const advisoryOnly: PlanRevision["advisoryOnly"] = [];
  const added: string[] = [];
  const cancelled: string[] = [];
  const changed: string[] = [];

  const currentByNorm = new Map<string, SubtaskDto>();
  for (const s of current) {
    const key = normTitle(s.title);
    // First match wins (titles assumed unique enough; duplicates rare).
    if (!currentByNorm.has(key)) currentByNorm.set(key, s);
  }

  const keptExisting = new Set<string>();
  const resultPlanIds: string[] = [];

  // 1. Pass over revision subtasks — match by title.
  revision.subtasks.forEach((r, idx) => {
    const existing = currentByNorm.get(normTitle(r.title));
    if (existing) {
      keptExisting.add(existing.id);
      const mutable = existing.status === "planned" || existing.status === "ready";
      if (mutable) {
        // REWRITE in place.
        mutations.push({
          kind: "rewrite",
          id: existing.id,
          planId: existing.planId,
          title: r.title,
          instructions: r.instructions ?? "",
          completionRequirements: r.completionRequirements ?? "",
          houseId: r.houseId ?? null,
          dependsOn: r.dependsOn ?? [],
          orderIndex: idx,
          context: r.context ?? {},
          artifacts: r.artifacts ?? [],
          description: r.description ?? "",
          type: r.type ?? "general",
        });
        changed.push(existing.id);
        resultPlanIds.push(existing.planId);
      } else {
        // Already delegated / in_flight / terminal — advisory only.
        advisoryOnly.push({ planId: existing.planId, title: r.title });
        // Keep it in the plan set under its existing plan id so new subtasks
        // may depend on it.
        resultPlanIds.push(existing.planId);
      }
    } else {
      // CREATE new subtask with a fresh plan id derived from the revision.
      const newId = `r${idx}`;
      mutations.push({
        kind: "create",
        id: newId,
        planId: newId,
        title: r.title,
        instructions: r.instructions ?? "",
        completionRequirements: r.completionRequirements ?? "",
        houseId: r.houseId ?? null,
        dependsOn: r.dependsOn ?? [],
        orderIndex: idx,
        context: r.context ?? {},
        artifacts: r.artifacts ?? [],
        description: r.description ?? "",
        type: r.type ?? "general",
      });
      added.push(newId);
      resultPlanIds.push(newId);
    }
  });

  // 2. Unmatched existing planned/ready → cancelled. Others untouched.
  for (const s of current) {
    if (!keptExisting.has(s.id)) {
      const status = s.status as SubtaskStatus;
      if (status === "planned" || status === "ready") {
        mutations.push({
          kind: "cancel",
          id: s.id,
          planId: s.planId,
          title: s.title,
        });
        cancelled.push(s.id);
      }
    }
  }

  // 3. Normalize new-subtask edges against the post-revision id set. A newly
  //    created subtask whose dep points at a cancelled/kept subtask by its
  //    (revised) title is not recoverable here — the orchestrator re-resolves
  //    edges after applying (Kahn breakCycles on the resulting DTO set). We just
  //    surface a normalized dependsOn list filtered to `resultPlanIds`.
  for (const m of mutations) {
    if (m.kind === "create" || m.kind === "rewrite") {
      m.dependsOn = (m.dependsOn ?? []).filter((d) => resultPlanIds.includes(d));
    }
  }

  return { mutations, advisoryOnly, added, cancelled, changed, resultPlanIds };
}
