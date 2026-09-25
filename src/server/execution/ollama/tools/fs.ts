/**
 * Filesystem tools — fs_read / fs_list / fs_write (Phase 5 Stage D).
 *
 * PATH SAFETY (critical — plan §17 risk 4): every path is re-validated against
 * the house's allowlist at EXECUTION time via `resolveSafePath`. The model is
 * never trusted; even a path the model believes is inside is re-resolved here.
 *
 * `resolveSafePath` requires the candidate to EXIST (it realpaths the candidate
 * to defeat `..` and symlink escapes). Writing to a NEW file therefore cannot
 * realpath the file itself — instead we resolve the PARENT DIRECTORY, join the
 * basename, then run the same prefix containment check. A symlink whose target
 * escapes the allowlist is caught because resolveSafePath realpaths the parent.
 *
 * Out-of-allowlist paths do NOT execute here — they are surfaced to the gate
 * (Stage E) so the user decides (never a silent refusal).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveSafePath } from "@/lib/paths";
import type { OllamaTool, ToolContext, ToolResult } from "./types";

/** Resolve + validate an existing path inside the allowlist (throws on escape). */
function safeExistingPath(candidate: string, allowlist: string[]): string {
  return resolveSafePath(candidate, allowlist);
}

/**
 * Safety flag for a fs_write target that may not exist yet. Returns
 * `{ inside: true, resolved }` when the parent directory realpathed inside the
 * allowlist and the joined basename remains prefix-contained; otherwise
 * `{ inside: false, resolved }` so the caller can surface it to the gate.
 *
 * It also distinguishes the two reasons a target is not `inside` so the error
 * surfaced to the model/user is accurate (M2/MINOR): the parent directory may
 * be MISSING (no error from resolveSafePath to misattribute) or may actually be
 * outside the allowlist.
 */
export interface ResolveWriteTargetResult {
  inside: boolean;
  resolved: string;
  /** 'outside' when the parent is outside the allowlist; 'missing-parent' when the parent dir does not exist; 'ok' when inside. */
  notInsideReason?: "outside" | "missing-parent";
}

export function resolveWriteTarget(
  candidate: string,
  allowlist: string[],
): ResolveWriteTargetResult {
  // Absolute-normalize without requiring existence.
  const abs = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
  const parent = path.dirname(abs);
  const basename = path.basename(abs);
  try {
    // Realpath the PARENT (must exist + be inside the allowlist).
    const safeParent = resolveSafePath(parent, allowlist);
    const resolved = path.join(safeParent, basename);
    // Prefix containment is redundant after resolveSafePath(parent) but kept as
    // a belt-and-braces check (the basename cannot contain separators).
    return { inside: true, resolved };
  } catch (err) {
    // Distinguish "parent does not exist" from "parent is outside the allowlist"
    // so callers / the gate don't misreport an out-of-allowlist reason for a
    // path that merely has missing intermediate directories.
    const msg = err instanceof Error ? err.message : String(err);
    const missing = /ENOENT|no such file|stat/i.test(msg);
    return { inside: false, resolved: abs, notInsideReason: missing ? "missing-parent" : "outside" };
  }
}

export const fsRead: OllamaTool = {
  name: "fs_read",
  description:
    "Read a file's UTF-8 text content. Provide an absolute path inside the house workspace.",
  permissionClass: "fs_read",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Absolute path to read" } },
    required: ["path"],
  },
  argsSchema: z.object({ path: z.string().min(1) }),
  async execute(ctx: ToolContext, args): Promise<ToolResult> {
    const pathArg = (args as { path: string }).path;
    try {
      const resolved = safeExistingPath(pathArg, ctx.allowlist);
      const content = await fs.readFile(resolved, "utf8");
      return { ok: true, output: content };
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: `fs_read: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const fsList: OllamaTool = {
  name: "fs_list",
  description: "List the entries of a directory. Provide an absolute path inside the house workspace.",
  permissionClass: "fs_read",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Absolute directory path" } },
    required: ["path"],
  },
  argsSchema: z.object({ path: z.string().min(1) }),
  async execute(ctx: ToolContext, args): Promise<ToolResult> {
    const pathArg = (args as { path: string }).path;
    try {
      const resolved = safeExistingPath(pathArg, ctx.allowlist);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const lines = entries.map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`);
      return { ok: true, output: lines.join("\n") || "(empty directory)" };
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: `fs_list: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const fsWrite: OllamaTool = {
  name: "fs_write",
  description:
    "Write UTF-8 text content to a file, creating it (and its parent dirs must already exist). " +
    "Provide an absolute path inside the house workspace.",
  permissionClass: "fs_write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to write" },
      content: { type: "string", description: "Text content to write" },
    },
    required: ["path", "content"],
  },
  argsSchema: z.object({ path: z.string().min(1), content: z.string() }),
  async execute(ctx: ToolContext, args): Promise<ToolResult> {
    const { path: pathArg, content } = args as { path: string; content: string };
    const target = resolveWriteTarget(pathArg, ctx.allowlist);
    if (!target.inside) {
      // Do NOT write outside the allowlist — surface to the gate (Stage E).
      // Phase 5 MINOR: report an accurate reason — a missing intermediate
      // directory is NOT an out-of-allowlist escape.
      const reason =
        target.notInsideReason === "missing-parent"
          ? `fs_write: parent directory does not exist (${target.resolved}) — create intermediate directories first`
          : `fs_write: path outside workspace allowlist (${target.resolved})`;
      return { ok: false, output: "", error: reason };
    }
    try {
      await fs.writeFile(target.resolved, content, "utf8");
      return { ok: true, output: `wrote ${target.resolved}`, filesTouched: [target.resolved] };
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: `fs_write: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
