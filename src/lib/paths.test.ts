import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSafePath, isPathAllowed, isAbsolutePath } from "@/lib/paths";

describe("resolveSafePath", () => {
  let dir: string;
  const nestedName = "velaris-nested";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-paths-"));
    fs.mkdirSync(path.join(dir, "allowed"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a path inside the allowlist", () => {
    const result = resolveSafePath(path.join(dir, "allowed"), [dir]);
    expect(result).toBe(path.join(dir, "allowed"));
  });

  it("accepts the allowlist root itself", () => {
    expect(resolveSafePath(dir, [dir])).toBe(dir);
  });

  it("rejects a path outside the allowlist", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-out-"));
    try {
      // A path INSIDE `outside` but not inside `dir`.
      const sub = path.join(outside, nestedName);
      fs.mkdirSync(sub);
      expect(() => resolveSafePath(sub, [dir])).toThrow(/outside the permitted/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a path outside a *narrower* allowlist (prefix must be an ancestor)", () => {
    // allowlist = dir/allowed; candidate = dir/other (inside dir, but not inside dir/allowed).
    const other = path.join(dir, "other");
    fs.mkdirSync(other);
    const allowlist = [path.join(dir, "allowed")];
    expect(() => resolveSafePath(other, allowlist)).toThrow(/outside the permitted/);
    // But dir/allowed itself and its descendants are allowed.
    expect(resolveSafePath(path.join(dir, "allowed"), allowlist)).toBe(path.join(dir, "allowed"));
  });

  it("rejects when the allowlist is empty", () => {
    expect(() => resolveSafePath(path.join(dir, "allowed"), [])).toThrow(/empty/);
  });

  it("rejects a nonexistent candidate path", () => {
    expect(() => resolveSafePath(path.join(dir, "nope"), [dir])).toThrow(/does not exist/);
  });

  it("isPathAllowed mirrors resolveSafePath success", () => {
    expect(isPathAllowed(path.join(dir, "allowed"), [dir])).toBe(true);
    expect(isPathAllowed(path.join(dir, "nope"), [dir])).toBe(false);
  });

  it("isAbsolutePath detects absolute paths (shared, client-safe)", () => {
    expect(isAbsolutePath("/home/velaris")).toBe(true);
    expect(isAbsolutePath("relative/path")).toBe(false);
  });
});
