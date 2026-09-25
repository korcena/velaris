/**
 * Adversarial tests — Path safety escapes (plan §17 risk 4, focus #4).
 *
 * Targets the fs_write NEW-file parent-resolution + symlink + prefix-collision
 * and `..` escape vectors beyond the author's happy-path tools test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWriteTarget } from "@/server/execution/ollama/tools/fs";
import { resolveSafePath } from "@/lib/paths";

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-adv-path-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-adv-outside-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("resolveWriteTarget — adversarial path escapes", () => {
  it("symlinked PARENT pointing outside the allowlist returns inside:false (new-file write)", () => {
    // workspace/escape -> outside (symlink dir). Writing workspace/escape/n.txt
    // must be detected as an escape because the parent realpaths outside.
    const link = path.join(workspace, "escape");
    fs.symlinkSync(outside, link);
    const target = path.join(link, "n.txt");
    const r = resolveWriteTarget(target, [workspace]);
    expect(r.inside).toBe(false);
  });

  it("prefix-collision allowlist /tmp/proj vs /tmp/proj-evil cannot escape", () => {
    // allowlist = [workspace], target sibling that SHARES the prefix
    const evil = workspace + "-evil";
    fs.mkdirSync(evil);
    const target = path.join(evil, "x.txt");
    const r = resolveWriteTarget(target, [workspace]);
    expect(r.inside).toBe(false);
    fs.rmSync(evil, { recursive: true, force: true });
  });

  it("direct `..` traversal into the parent is refused", () => {
    const parent = path.dirname(workspace);
    const escapeTarget = path.join(parent, "sneaky.txt");
    const target = path.join(workspace, "..", "sneaky.txt");
    expect(path.resolve(target)).toBe(escapeTarget);
    const r = resolveWriteTarget(target, [workspace]);
    expect(r.inside).toBe(false);
  });

  it("absolute path pointing outside is refused", () => {
    expect(resolveWriteTarget(path.join(outside, "f.txt"), [workspace]).inside).toBe(false);
  });

  it("nested nonexistent parent is refused (realpath of parent must exist)", () => {
    const target = path.join(workspace, "does", "not", "exist", "f.txt");
    const r = resolveWriteTarget(target, [workspace]);
    expect(r.inside).toBe(false);
  });

  it("a genuine new file directly under the allowlist is allowed", () => {
    const target = path.join(workspace, "new.txt");
    expect(resolveWriteTarget(target, [workspace]).inside).toBe(true);
  });
});

describe("resolveSafePath — symlink file escapes", () => {
  it("a file reached THROUGH a symlink that escapes the allowlist is refused", () => {
    // outside/a.txt secret; workspace/secret -> outside/a.txt symlink file
    const secret = path.join(outside, "a.txt");
    fs.writeFileSync(secret, "secret");
    const link = path.join(workspace, "secret");
    fs.symlinkSync(secret, link);
    expect(() => resolveSafePath(link, [workspace])).toThrow(/allowlist|outside/i);
  });
});
