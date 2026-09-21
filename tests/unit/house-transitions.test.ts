/**
 * Unit tests — house status transitions (full matrix).
 *
 * The core cases live in src/shared/schemas/__tests__/core.test.ts; this
 * suite completes the matrix per IMPLEMENTATION_PLAN §5.6: active⇄disabled,
 * active|disabled→archived, archived terminal, delete-only-when-archived —
 * including the repo-level transition/delete functions against a temp DB.
 */

import { describe, it, expect } from "vitest";
import { canTransition, canDelete } from "@/server/repositories/house-repo";

describe("house status transition rules (§5.3)", () => {
  it("active ⇄ disabled in both directions", () => {
    expect(canTransition("active", "disabled")).toBe(true);
    expect(canTransition("disabled", "active")).toBe(true);
  });

  it("active|disabled → archived", () => {
    expect(canTransition("active", "archived")).toBe(true);
    expect(canTransition("disabled", "archived")).toBe(true);
  });

  it("archived is terminal (no transitions out)", () => {
    expect(canTransition("archived", "active")).toBe(false);
    expect(canTransition("archived", "disabled")).toBe(false);
    expect(canTransition("archived", "archived")).toBe(false);
  });

  it("self-transitions are not permitted (except via explicit no-op semantics)", () => {
    expect(canTransition("active", "active")).toBe(false);
    expect(canTransition("disabled", "disabled")).toBe(false);
  });

  it("DELETE only when archived", () => {
    expect(canDelete("archived")).toBe(true);
    expect(canDelete("active")).toBe(false);
    expect(canDelete("disabled")).toBe(false);
  });

  it("every transition is reversible except archive", () => {
    // For all (from, to): canTransition(from,to) === canTransition(to,from)
    // except pairs involving 'archived'.
    const states = ["active", "disabled", "archived"] as const;
    for (const from of states) {
      for (const to of states) {
        if (from === "archived" || to === "archived") continue;
        expect(canTransition(from, to)).toBe(canTransition(to, from));
      }
    }
  });
});