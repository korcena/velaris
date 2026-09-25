/**
 * Unit tests — Ollama permission gate matrix (Phase 5 Stage E).
 *
 * The gate is a PURE function mapping (tool, args, house config) → allow|ask|deny.
 *  - fs_read inside → execute; outside → always ask (safety override)
 *  - fs_write: mode allow→execute, ask→ask, deny→deny; outside → always ask
 *  - shell/network: mode allow→execute, ask→ask, deny→deny (network defaults deny)
 *  - git: read ops by mode; mutating ops ALWAYS ask
 *  - risky_only behaves as always (parity with OpenCode runner.ts:481)
 *  - approval_policy 'never' does NOT auto-execute an out-of-allowlist ask
 */

import { describe, it, expect } from "vitest";
import { gateToolCall, shouldAutoExecute, type PermissionsGateConfig } from "@/server/execution/ollama/tools/permissions";
import { fsRead, fsWrite } from "@/server/execution/ollama/tools/fs";
import { shellExec } from "@/server/execution/ollama/tools/shell";
import { webFetch } from "@/server/execution/ollama/tools/web-fetch";
import { gitStatus, git, gitDiff } from "@/server/execution/ollama/tools/git";
import type { Permissions } from "@/shared/types";

const perms = (p: Partial<Permissions> = {}): Permissions => ({
  fileSystem: "ask",
  shell: "ask",
  network: "deny",
  git: "allow",
  ...p,
});

function cfg(perm: Permissions, policy: "never" | "always" | "risky_only" = "always", pathInside = true): PermissionsGateConfig {
  return { permissions: perm, approvalPolicy: policy, pathInsideAllowlist: pathInside };
}

describe("fs_read", () => {
  it("executes inside the allowlist regardless of fs mode", () => {
    expect(gateToolCall(fsRead, cfg(perms({ fileSystem: "deny" }), "always", true)).action).toBe("execute");
  });

  it("ALWAYS asks outside the allowlist (safety override even under deny/never)", () => {
    expect(gateToolCall(fsRead, cfg(perms({ fileSystem: "deny" }), "never", false)).action).toBe("ask");
  });
});

describe("fs_write", () => {
  it("mode allow + inside → execute", () => {
    expect(gateToolCall(fsWrite, cfg(perms({ fileSystem: "allow" }), "always", true)).action).toBe("execute");
  });
  it("mode ask + inside → ask (permission)", () => {
    const d = gateToolCall(fsWrite, cfg(perms({ fileSystem: "ask" }), "always", true));
    expect(d.action).toBe("ask");
    if (d.action === "ask") expect(d.kind).toBe("permission");
  });
  it("mode deny + inside → deny", () => {
    expect(gateToolCall(fsWrite, cfg(perms({ fileSystem: "deny" }), "always", true)).action).toBe("deny");
  });
  it("outside the allowlist ALWAYS asks, even under deny mode", () => {
    expect(gateToolCall(fsWrite, cfg(perms({ fileSystem: "deny" }), "never", false)).action).toBe("ask");
  });
});

describe("shell", () => {
  it("allow → execute", () => {
    expect(gateToolCall(shellExec, cfg(perms({ shell: "allow" }))).action).toBe("execute");
  });
  it("ask → ask", () => {
    expect(gateToolCall(shellExec, cfg(perms({ shell: "ask" }))).action).toBe("ask");
  });
  it("deny → deny", () => {
    expect(gateToolCall(shellExec, cfg(perms({ shell: "deny" }))).action).toBe("deny");
  });
});

describe("network", () => {
  it("denied by default", () => {
    expect(gateToolCall(webFetch, cfg(perms())).action).toBe("deny");
  });
  it("allow → execute", () => {
    expect(gateToolCall(webFetch, cfg(perms({ network: "allow" }))).action).toBe("execute");
  });
  it("ask → ask", () => {
    expect(gateToolCall(webFetch, cfg(perms({ network: "ask" }))).action).toBe("ask");
  });
});

describe("git", () => {
  it("read-only git ops follow the git mode", () => {
    expect(gateToolCall(gitStatus, cfg(perms({ git: "allow" }))).action).toBe("execute");
    expect(gateToolCall(gitDiff, cfg(perms({ git: "ask" }))).action).toBe("ask");
    expect(gateToolCall(gitStatus, cfg(perms({ git: "deny" }))).action).toBe("deny");
  });
  it("the mutating 'git' tool ALWAYS asks (side-effect parity with writes)", () => {
    expect(gateToolCall(git, cfg(perms({ git: "allow" }))).action).toBe("ask");
    expect(gateToolCall(git, cfg(perms({ git: "deny" }))).action).toBe("ask");
  });
});

describe("risky_only behaves as always (Q11 paritY)", () => {
  it("a shell call under risky_only asks exactly like always", () => {
    expect(gateToolCall(shellExec, cfg(perms({ shell: "ask" }), "risky_only")).action).toBe("ask");
  });
  it("a fs_write under risky_only + ask asks", () => {
    expect(gateToolCall(fsWrite, cfg(perms({ fileSystem: "ask" }), "risky_only", true)).action).toBe("ask");
  });
});

describe("shouldAutoExecute (approval_policy modulation)", () => {
  it("never auto-executes an out-of-allowlist ask (safety)", () => {
    const g = gateToolCall(fsWrite, cfg(perms({ fileSystem: "ask" }), "never", false));
    expect(g.action).toBe("ask");
    expect(shouldAutoExecute(g, cfg(perms({ fileSystem: "ask" }), "never", false))).toBe(false);
  });
  it("never + inside allowlist + ask gate → auto-execute (no bird)", () => {
    const g = gateToolCall(shellExec, cfg(perms({ shell: "ask" }), "never", true));
    expect(g.action).toBe("ask");
    expect(shouldAutoExecute(g, cfg(perms({ shell: "ask" }), "never", true))).toBe(true);
  });
  it("always + ask gate → not auto-executed", () => {
    const g = gateToolCall(shellExec, cfg(perms({ shell: "ask" }), "always", true));
    expect(shouldAutoExecute(g, cfg(perms({ shell: "ask" }), "always", true))).toBe(false);
  });
});
