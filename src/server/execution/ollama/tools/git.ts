/**
 * Git tool — thin read-only wrapper scoped to allowlisted repos (Phase 5 Stage
 * D, optional). Registered only when `"git"` is in the house's tools list.
 *
 * SAFETY: read-only ops (`status`, `diff`) are safe and execute under the
 * `git` permission mode. Mutating ops (`commit`, `push`, `checkout`) are
 * approval-gated consistent with Stage E (they carry `mutating: true`, so the
 * gate treats them like a write even under `allow` — see permissions.ts).
 *
 * Scope: commands run via execFile with an argument array against the working
 * directory (allowlist-validated). No shell-string interpolation.
 */

import { execFile } from "node:child_process";
import { z } from "zod";
import type { OllamaTool, ToolContext, ToolResult } from "./types";

const GIT_TIMEOUT_MS = 20_000;

const MUTATING_SUBCOMMANDS = new Set(["commit", "push", "pull", "checkout", "merge", "rebase", "reset", "rm", "mv"]);

function runGit(workDir: string, args: string[], command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: workDir, timeout: GIT_TIMEOUT_MS, maxBuffer: 1_000_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (err as { code?: number | null })?.code ?? -1 : 0;
      resolve({ stdout: typeof stdout === "string" ? stdout : String(stdout), stderr: typeof stderr === "string" ? stderr : String(stderr), code });
    });
  });
}

export const gitStatus: OllamaTool = {
  name: "git_status",
  description: "Show current git status (branch, staged/modified/untracked files) in the house workspace.",
  permissionClass: "git",
  parameters: { type: "object", properties: {}, required: [] },
  argsSchema: z.object({}).default({}),
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { stdout, stderr, code } = await runGit(ctx.workingDirectory, ["status", "--short", "--branch"], "git");
    if (code !== 0) return { ok: false, output: "", error: `git_status: ${stderr}` };
    return { ok: true, output: stdout || "(clean)" };
  },
};

export const gitDiff: OllamaTool = {
  name: "git_diff",
  description: "Show the working-tree diff (unstaged changes) in the house workspace.",
  permissionClass: "git",
  parameters: { type: "object", properties: {}, required: [] },
  argsSchema: z.object({}).default({}),
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { stdout, stderr, code } = await runGit(ctx.workingDirectory, ["diff"], "git");
    if (code !== 0) return { ok: false, output: "", error: `git_diff: ${stderr}` };
    return { ok: true, output: stdout || "(no unstaged changes)" };
  },
};

export const git: OllamaTool = {
  name: "git",
  description:
    "Run a git subcommand in the house workspace. Supply the full argument array (subcommand + flags), e.g. ['log','--oneline','-5']. Read-only subcommands run directly; mutating subcommands (commit/push/pull/checkout/merge/…) require approval.",
  permissionClass: "git",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      args: { type: "array", items: { type: "string" }, description: "Git argument array (subcommand + flags)" },
    },
    required: ["args"],
  },
  argsSchema: z.object({ args: z.array(z.string()).min(1) }),
  async execute(ctx: ToolContext, args): Promise<ToolResult> {
    const argList = (args as { args: string[] }).args;
    // Phase 5 M2 (hardened) — git `-c`/alias escape: `git -c alias.x='!sh …'`
    // (and the attached `git -calias.x='!sh …'`, plus `--config` forms) lets the
    // model run an arbitrary host command — the allowlist only gates the working
    // directory, not git's reach. Do not rely on git's own parsing to reject the
    // attached form: the guard must be fail-closed. Reject every arg whose value
    // begins with `-c` (`-c`, `-c=`, `-calias.…`) and every `--config` form, and
    // any `alias.*=<string>` definition outright.
    const isConfigOverride = (a: string): boolean =>
      /^-c/.test(a) || a === "--config" || a.startsWith("--config=");
    if (argList.some(isConfigOverride)) {
      return { ok: false, output: "", error: "git: '-c' (config override) is not allowed — it can embed a shell command via an alias" };
    }
    if (argList.some((a) => /^alias\./.test(a))) {
      return { ok: false, output: "", error: "git: defining an alias is not allowed (alias.*=<string> can run a host command)" };
    }
    const sub = argList[0] ?? "";
    const mutates = MUTATING_SUBCOMMANDS.has(sub);
    if (mutates) {
      // Never execute a mutating git op here — surface to the gate (Stage E).
      return {
        ok: false,
        output: "",
        error: `git: '${sub}' requires approval before execution (mutating operation)`,
      };
    }
    const { stdout, stderr, code } = await runGit(ctx.workingDirectory, argList, "git");
    if (code !== 0) return { ok: false, output: "", error: `git: ${stderr.slice(0, 2000)}` };
    return { ok: true, output: stdout || "(no output)" };
  },
};
