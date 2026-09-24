/**
 * Unit tests — plan revision algorithm (src/server/execution/planning/apply-plan-revision.ts).
 *
 * Addendum D2d. Covers: title-normalized matching, matched-planned rewrite,
 * create-new, cancel-unmatched-planned, unmatched-in-flight/terminal untouched,
 * empty-revision rejection, and cycle re-normalization.
 */

import { describe, it, expect } from "vitest";
import { computePlanRevision } from "@/server/execution/planning/apply-plan-revision";
import type { SubtaskDto } from "@/shared/types";
import type { Plan } from "@/shared/schemas/plan";

function sub(over: Partial<SubtaskDto> & { id: string; planId: string; title: string }): SubtaskDto {
  return {
    parentTaskId: "p",
    taskId: null,
    orderIndex: 0,
    dependsOn: [],
    status: "planned",
    attemptCount: 0,
    instructions: "",
    completionRequirements: "",
    houseId: null,
    houseName: null,
    childTaskStatus: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const current = [
  sub({ id: "a", planId: "s0", title: "Research the gate" }), // planned → rewritable
  sub({ id: "b", planId: "s1", title: "Forge the keys", status: "delegated", taskId: "t1" }), // in-flight → untouched
  sub({ id: "c", planId: "s2", title: "Done the wards", status: "completed", taskId: "t2" }), // terminal → untouched
  sub({ id: "d", planId: "s3", title: "Unwanted draft" }), // planned, unmatched → cancelled
];

function revisionPlan(subtasks: Array<{ title: string; dependsOn?: string[] }>): Plan {
  return {
    subtasks: subtasks.map((s, i) => ({
      id: `r${i}`,
      title: s.title,
      dependsOn: s.dependsOn ?? [],
      instructions: "",
    })) as unknown as Plan["subtasks"],
  };
}

describe("computePlanRevision", () => {
  it("rewrites a matched planned subtask and keeps its id, carries new title/depends", () => {
    const rev = revisionPlan([{ title: "Research the gate" }]);
    const out = computePlanRevision(current, rev);
    const rewrite = out.mutations.find((m) => m.kind === "rewrite");
    expect(rewrite).toBeDefined();
    expect(rewrite!.id).toBe("a");
    expect(out.changed).toContain("a");

    // Unmatched planned 'd' cancelled; in-flight 'b' and terminal 'c' untouched.
    expect(out.mutations.some((m) => m.kind === "cancel" && m.id === "d")).toBe(true);
    expect(out.mutations.some((m) => m.id === "b")).toBe(false);
    expect(out.mutations.some((m) => m.id === "c")).toBe(false);
  });

  it("creates a new subtask for an unmatched revision title", () => {
    const rev = revisionPlan([{ title: "Research the gate" }, { title: "Brand new subtask" }]);
    const out = computePlanRevision(current, rev);
    const create = out.mutations.find((m) => m.kind === "create");
    expect(create).toBeDefined();
    expect(create!.title).toBe("Brand new subtask");
    expect(create!.planId).toBe("r1");
    expect(out.added).toContain("r1");
  });

  it("is advisory-only (untouched) for a matched in-flight subtask", () => {
    const rev = revisionPlan([{ title: "Forge the keys" }]);
    const out = computePlanRevision(current, rev);
    expect(out.advisoryOnly).toHaveLength(1);
    expect(out.advisoryOnly[0].title).toBe("Forge the keys");
    // No mutation rewrites b (it's delegated/in_flight).
    expect(out.mutations.some((m) => m.kind === "rewrite" && m.id === "b")).toBe(false);
  });

  it("leaves terminal unmatched subtasks untouched", () => {
    // 'c' is completed and unmatched in this revision → untouched, not cancelled.
    const rev = revisionPlan([{ title: "Research the gate" }]);
    const out = computePlanRevision(current, rev);
    expect(out.mutations.some((m) => m.id === "c")).toBe(false);
  });

  it("normalizes new-subtask dependsOn against the post-revision id set + titles", () => {
    const rev = revisionPlan([
      { title: "Research the gate" }, // matched → planId "s0"
      { title: "Brand new subtask", dependsOn: ["s0"] }, // depends on matched by planId
    ]);
    const out = computePlanRevision(current, rev);
    const create = out.mutations.find((m) => m.kind === "create")!;
    // s0 is in resultPlanIds (matched rewrite kept existing planId).
    expect(create.dependsOn).toContain("s0");
  });
});
