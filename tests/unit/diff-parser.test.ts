/**
 * U3 — unit tests for the diff artifact parser (src/components/houses/results/diff-parser.ts).
 */

import { describe, it, expect } from "vitest";
import { parseDiffArtifact, parsePatch } from "@/components/houses/results/diff-parser";

/**
 * A fixture in the EXACT format the engine writes (runner.ts persistTerminal):
 *   `${status} ${file}\n${patch}` joined by "\n---\n".
 */
const RUNNER_FORMAT_FIXTURE = [
  "modified src/a.txt",
  "@@ -1,3 +1,4 @@",
  " import { x } from 'z';",
  "+export const added = 1;",
  " const keep = 2;",
  "-const removed = 3;",
  " context line",
  "---",
  "created NEW.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+Body line",
].join("\n");

describe("parseDiffArtifact", () => {
  it("splits a runner-format blob into per-file entries", () => {
    const entries = parseDiffArtifact(RUNNER_FORMAT_FIXTURE);
    expect(entries).toHaveLength(2);

    expect(entries[0].status).toBe("modified");
    expect(entries[0].file).toBe("src/a.txt");
    expect(entries[0].patch).toContain("@@ -1,3 +1,4 @@");
    expect(entries[0].patch).toContain("+export const added = 1;");
    expect(entries[0].patch).toContain("-const removed = 3;");

    expect(entries[1].status).toBe("created");
    expect(entries[1].file).toBe("NEW.md");
  });

  it("handles a single file without a separator", () => {
    const single = "modified app.ts\n@@ -1\n+line";
    const entries = parseDiffArtifact(single);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("modified");
    expect(entries[0].file).toBe("app.ts");
  });

  it("returns [] for empty content", () => {
    expect(parseDiffArtifact("")).toEqual([]);
    expect(parseDiffArtifact("   ")).toEqual([]);
    expect(parseDiffArtifact(undefined as unknown as string)).toEqual([]);
    expect(parseDiffArtifact(null as unknown as string)).toEqual([]);
  });

  it("skips malformed empty chunks", () => {
    const bad = "modified a.ts\n+line\n---\n\n---\ncreated b.ts\n+file2";
    const entries = parseDiffArtifact(bad);
    expect(entries.map((e) => e.file)).toEqual(["a.ts", "b.ts"]);
  });

  it("treats a blank status as 'modified'", () => {
    const entries = parseDiffArtifact("src/x.ts\n+line");
    expect(entries[0].status).toBe("modified");
    expect(entries[0].file).toBe("src/x.ts");
  });
});

describe("parsePatch", () => {
  it("classifies add/del/hunk/context lines", () => {
    const patch = [
      "@@ -1 +1 @@",
      " context",
      "+added",
      "-removed",
      " plain",
    ].join("\n");
    const lines = parsePatch(patch);
    expect(lines.map((l) => l.kind)).toEqual(["hunk", "context", "add", "del", "context"]);
  });

  it("is tolerant of malformed / empty patches", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch(undefined as unknown as string)).toEqual([]);
    expect(parsePatch("   ")).toEqual([]);
    expect(parsePatch("\n")).toEqual([]);
  });

  it("preserves the raw line text including the diff marker", () => {
    const lines = parsePatch("+hello\n-world");
    expect(lines).toEqual([
      { kind: "add", text: "+hello" },
      { kind: "del", text: "-world" },
    ]);
  });

  it("handles a patch with no hunks (raw +/- only)", () => {
    const lines = parsePatch("+a\n+b\n-c");
    expect(lines.map((l) => l.kind)).toEqual(["add", "add", "del"]);
  });
});
