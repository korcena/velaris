/**
 * Unit tests for the pure runtime-status → map-effect mapping
 * (src/components/map/status-effects.ts).
 */

import { describe, it, expect } from "vitest";
import {
  EFFECT_KEYS,
  EFFECT_LABELS,
  LEGEND_EFFECTS,
  TRANSIENT_FAIL_MS,
  effectForRuntime,
  effectForHouse,
  isTransientFail,
  isStickyFail,
  transientFailEffect,
  countEffects,
  isDimmedByFilter,
  type EffectInput,
  type MapEffect,
} from "@/components/map/status-effects";
import type { HouseRuntimeStatus, HouseStatus } from "@/shared/types";

const RUNTIME_STATUSES: HouseRuntimeStatus[] = [
  "idle",
  "planning",
  "working",
  "awaiting_approval",
  "awaiting_input",
  "paused",
];

const EXPECTED: Record<HouseRuntimeStatus, MapEffect> = {
  idle: "idle",
  planning: "planning",
  working: "working",
  awaiting_approval: "need",
  awaiting_input: "need",
  paused: "paused",
};

function input(partial: Partial<EffectInput> & { runtimeStatus: HouseRuntimeStatus }): EffectInput {
  return { status: "active", ...partial };
}

describe("constants", () => {
  it("lists every effect key once, with labels and a dimmed-free legend", () => {
    expect(new Set(EFFECT_KEYS).size).toBe(EFFECT_KEYS.length);
    for (const k of EFFECT_KEYS) expect(EFFECT_LABELS[k]).toBeTruthy();
    expect(LEGEND_EFFECTS).not.toContain("dimmed");
    expect(LEGEND_EFFECTS.length).toBe(EFFECT_KEYS.length - 1);
  });
});

describe("effectForRuntime", () => {
  it("maps every runtime status to the expected effect", () => {
    for (const runtime of RUNTIME_STATUSES) {
      expect(effectForRuntime(runtime)).toBe(EXPECTED[runtime]);
    }
  });

  it("distinguishes planning from working", () => {
    expect(effectForRuntime("planning")).toBe("planning");
    expect(effectForRuntime("working")).toBe("working");
    expect(effectForRuntime("planning")).not.toBe(effectForRuntime("working"));
  });

  it("maps both awaiting statuses to need", () => {
    expect(effectForRuntime("awaiting_approval")).toBe("need");
    expect(effectForRuntime("awaiting_input")).toBe("need");
  });

  it("keeps paused as its own distinct key", () => {
    expect(effectForRuntime("paused")).toBe("paused");
  });
});

describe("effectForHouse", () => {
  it("passes active houses through the runtime mapping", () => {
    for (const runtime of RUNTIME_STATUSES) {
      expect(effectForHouse(input({ runtimeStatus: runtime }))).toBe(EXPECTED[runtime]);
    }
  });

  it("dims disabled and archived houses for every runtime status", () => {
    for (const status of ["disabled", "archived"] as HouseStatus[]) {
      for (const runtime of RUNTIME_STATUSES) {
        expect(effectForHouse(input({ status, runtimeStatus: runtime }))).toBe("dimmed");
      }
    }
  });

  it("dimmed wins over a transient fail flash", () => {
    expect(
      effectForHouse(input({ status: "archived", runtimeStatus: "working", transientFail: true })),
    ).toBe("dimmed");
  });

  it("maps High Lord aborted planState to sticky fail", () => {
    expect(
      effectForHouse(input({ runtimeStatus: "idle", kind: "high_lord", planState: "aborted" })),
    ).toBe("fail");
  });

  it("does not sticky-fail a non-High-Lord with an aborted planState", () => {
    expect(
      effectForHouse(input({ runtimeStatus: "idle", kind: "agent", planState: "aborted" })),
    ).toBe("idle");
  });

  it("does not sticky-fail a High Lord whose plan is not aborted", () => {
    for (const planState of ["idle", "planning", "active", "completed"] as const) {
      expect(
        effectForHouse(input({ runtimeStatus: "working", kind: "high_lord", planState })),
      ).toBe("working");
    }
  });

  it("maps a transient fail to fail", () => {
    expect(effectForHouse(input({ runtimeStatus: "idle", transientFail: true }))).toBe("fail");
  });

  it("prefers a transient fail over the sticky fail signal (both read fail)", () => {
    expect(
      effectForHouse(
        input({ runtimeStatus: "idle", kind: "high_lord", planState: "aborted", transientFail: true }),
      ),
    ).toBe("fail");
  });
});

describe("isTransientFail", () => {
  it("is true only for failed and aborted frames", () => {
    expect(isTransientFail("failed")).toBe(true);
    expect(isTransientFail("aborted")).toBe(true);
    expect(isTransientFail("completed")).toBe(false);
  });
});

describe("isStickyFail", () => {
  it("requires high_lord + aborted", () => {
    expect(isStickyFail({ kind: "high_lord", planState: "aborted" })).toBe(true);
    expect(isStickyFail({ kind: "agent", planState: "aborted" })).toBe(false);
    expect(isStickyFail({ kind: "high_lord", planState: "active" })).toBe(false);
    expect(isStickyFail({})).toBe(false);
  });
});

describe("transientFailEffect", () => {
  it("flashes fail while inside the transient window", () => {
    expect(transientFailEffect("idle", "failed", 0)).toBe("fail");
    expect(transientFailEffect("working", "aborted", TRANSIENT_FAIL_MS - 1)).toBe("fail");
  });

  it("resolves back to the base effect once elapsed", () => {
    expect(transientFailEffect("idle", "failed", TRANSIENT_FAIL_MS)).toBe("idle");
    expect(transientFailEffect("need", "aborted", TRANSIENT_FAIL_MS + 5000)).toBe("need");
  });

  it("ignores non-fail frame kinds", () => {
    expect(transientFailEffect("working", "completed", 0)).toBe("working");
    expect(transientFailEffect("idle", "completed", TRANSIENT_FAIL_MS + 1)).toBe("idle");
  });
});

describe("countEffects", () => {
  it("sums per effect, including dimmed", () => {
    const houses: EffectInput[] = [
      input({ runtimeStatus: "idle" }),
      input({ runtimeStatus: "idle" }),
      input({ runtimeStatus: "planning" }),
      input({ runtimeStatus: "working" }),
      input({ runtimeStatus: "awaiting_approval" }),
      input({ runtimeStatus: "awaiting_input" }),
      input({ runtimeStatus: "paused" }),
      input({ runtimeStatus: "idle", transientFail: true }),
      input({ runtimeStatus: "working", kind: "high_lord", planState: "aborted" }),
      input({ status: "archived", runtimeStatus: "idle" }),
    ];
    const counts = countEffects(houses);
    expect(counts.idle).toBe(2);
    expect(counts.planning).toBe(1);
    expect(counts.working).toBe(1);
    expect(counts.need).toBe(2);
    expect(counts.paused).toBe(1);
    expect(counts.fail).toBe(2);
    expect(counts.dimmed).toBe(1);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(houses.length);
  });

  it("returns all-zero counts for an empty list", () => {
    expect(countEffects([])).toEqual({
      idle: 0,
      planning: 0,
      working: 0,
      need: 0,
      paused: 0,
      fail: 0,
      dimmed: 0,
    });
  });
});

describe("isDimmedByFilter", () => {
  it("dims nothing when no filter is active", () => {
    for (const effect of EFFECT_KEYS) {
      expect(isDimmedByFilter(effect, null)).toBe(false);
    }
  });

  it("keeps the matching effect lit and dims every other effect", () => {
    const filter: MapEffect = "working";
    expect(isDimmedByFilter("working", filter)).toBe(false);
    for (const effect of EFFECT_KEYS) {
      if (effect === filter) continue;
      expect(isDimmedByFilter(effect, filter)).toBe(true);
    }
  });

  it("treats dimmed houses as non-matching while a filter is active", () => {
    expect(isDimmedByFilter("dimmed", "idle")).toBe(true);
  });
});
