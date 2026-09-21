/**
 * Unit tests — resolveSafePath edge cases (Phase 1), per IMPLEMENTATION_PLAN §5.6.
 *
 * Complements src/lib/paths.test.ts with the security-focused cases:
 * traversal attempts, symlink escapes, prefix-spoofing, realpath behavior,
 * and non-allowlisted rejection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSafePath, isPathAllowed } from "@/lib/paths";

describe("resolveSafePath — security edges", () => {
  let root: string;
  let allowed: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-safe-"));
    allowed = path.join(root, "workspace");
    fs.mkdirSync(allowed);
    fs.mkdirSync(path.join(root, "outside"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("blocks ../ traversal that would escape the allowlist", () => {
    expect(() =>
      resolveSafePath(path.join(allowed, "..", "outside"), [allowed]),
    ).toThrow(/outside the permitted/);
  });

  it("blocks deep ../../.. escapes toward the filesystem root", () => {
    expect(() =>
      resolveSafePath(path.join(allowed, "..", "..", "..", "..", "etc"), [allowed]),
    ).toThrow();
  });

  it("resolves a legal .. inside the allowlist (path.normalize via resolve)", () => {
    const inner = path.join(allowed, "sub");
    fs.mkdirSync(inner);
    // allowed/sub/../sub resolves to allowed/sub — still inside.
    const result = resolveSafePath(path.join(inner, "..", "sub"), [allowed]);
    expect(result).toBe(inner);
  });

  it("rejects a sibling directory whose name merely shares a prefix (segment-aware)", () => {
    // allowlist: .../workspace — candidate: .../workspace-evil must NOT pass
    const evil = path.join(root, "workspace-evil");
    fs.mkdirSync(evil);
    expect(() => resolveSafePath(evil, [allowed])).toThrow(/outside the permitted/);
  });

  it("blocks a symlink inside the allowlist pointing outside it", () => {
    const link = path.join(allowed, "escape-link");
    fs.symlinkSync(path.join(root, "outside"), link);
    expect(() => resolveSafePath(link, [allowed])).toThrow(/outside the permitted/);
  });

  it("blocks a symlink chain that resolves outside the allowlist", () => {
    const outsideTarget = path.join(root, "outside", "secret.txt");
    fs.writeFileSync(outsideTarget, "x");
    // Link inside allowed -> link in outside -> file
    const intermediate = path.join(root, "outside", "inter");
    fs.symlinkSync(outsideTarget, intermediate);
    const link = path.join(allowed, "chain-link");
    fs.symlinkSync(intermediate, link);
    expect(() => resolveSafePath(link, [allowed])).toThrow(/outside the permitted/);
  });

  it("follows realpath so a symlinked allowlist entry still permits its real location", () => {
    const realWork = path.join(root, "outside", "shared-work");
    fs.mkdirSync(realWork);
    fs.writeFileSync(path.join(realWork, "file.txt"), "x");
    // User registers a symlink path as their allowlist entry...
    const alias = path.join(root, "alias");
    fs.symlinkSync(realWork, alias);
    // ...and a candidate inside the real directory is permitted, because both
    // sides are realpath'd before the prefix check.
    const result = resolveSafePath(path.join(alias, "file.txt"), [alias]);
    expect(result).toBe(path.join(realWork, "file.txt"));
  });

  it("rejects a file (not a directory) inside the allowlist? No — files are fine if inside", () => {
    const file = path.join(allowed, "notes.txt");
    fs.writeFileSync(file, "x");
    expect(resolveSafePath(file, [allowed])).toBe(file);
  });

  it("rejects candidates that do not exist on disk (realpath requirement)", () => {
    expect(() => resolveSafePath(path.join(allowed, "ghost"), [allowed])).toThrow(
      /does not exist/,
    );
  });

  it("rejects when NO allowlist entry exists on disk", () => {
    const missing = path.join(root, "not-registered");
    expect(() => resolveSafePath(allowed, [missing])).toThrow(
      /None of the allowlist entries/,
    );
  });

  it("permits the first matching entry among several allowlist roots", () => {
    const second = path.join(root, "outside");
    const inner = path.join(allowed, "a");
    fs.mkdirSync(inner);
    const result = resolveSafePath(inner, [second, allowed]);
    expect(result).toBe(inner);
  });

  it("isPathAllowed returns false for every rejection above", () => {
    const evil = path.join(root, "workspace-evil");
    fs.mkdirSync(evil);
    expect(isPathAllowed(evil, [allowed])).toBe(false);
    expect(isPathAllowed(path.join(allowed, "ghost"), [allowed])).toBe(false);
    expect(isPathAllowed(allowed, [])).toBe(false);
  });
});