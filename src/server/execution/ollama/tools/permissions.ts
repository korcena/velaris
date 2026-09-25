/**
 * Permission gating — the PURE gate map for tool execution (Phase 5 Stage E).
 *
 * Maps (tool permission class, house permission mode, approval policy, path
 * containment) → allow | ask | deny, reusing the existing approval/notification
 * pipeline in the runtime (not here — this module stays pure).
 *
 * Matrix (mirrors AGENT_ORCHESTRATION §9.3; decision Q11 = `risky_only` behaves
 * as `always` — parity with the OpenCode path runner.ts:481, no new risk
 * classifier):
 *
 *   | class     | mode   | path?          | decision |
 *   |-----------|--------|----------------|----------|
 *   | fs_read   | any    | inside         | execute  |
 *   | fs_read   | any    | OUTSIDE        | ask*     |
 *   | fs_write  | allow  | inside         | execute  |
 *   | fs_write  | ask    | inside         | ask      |
 *   | fs_write  | deny   | inside         | deny     |
 *   | fs_write  | any    | OUTSIDE        | ask*     |
 *   | shell     | allow  | —              | execute  |
 *   | shell     | ask    | —              | ask      |
 *   | shell     | deny   | —              | deny     |
 *   | network   | allow  | —              | execute  |
 *   | network   | ask    | —              | ask      |
 *   | network   | deny   | —              | deny (default) |
 *   | git (read)| allow  | —              | execute  |
 *   | git (read)| ask    | —              | ask      |
 *   | git (read)| deny   | —              | deny     |
 *   | git (mutating)| any  | —           | ask      |   <- mutating always asks
 *
 * * = a safety override: a path OUTSIDE the workspace allowlist is ALWAYS a user
 *   decision — even under `approval_policy='never'` / mode `deny`, because the
 *   model may write outside the sandbox. The caller (runtime) decides whether to
 *   gate an out-of-allowlist write as `ask` vs `deny` based on the policy; we
 *   always surface it as `ask` so the human can refuse.
 */

import type { Permissions } from "@/shared/types";
import type { OllamaTool } from "./types";

export type ApprovalPolicy = "never" | "always" | "risky_only";

export interface PermissionsGateConfig {
  /** Per-action permission modes from the house config. */
  permissions: Permissions;
  /** The house's approval policy. */
  approvalPolicy: ApprovalPolicy;
  /** Whether the tool's target path resolved inside the allowlist. */
  pathInsideAllowlist: boolean;
}

export type GateDecision =
  | { action: "execute" }
  | { action: "deny"; reason: string }
  | { action: "ask"; kind: "permission"; title: string; message: string };

function modeFor(tool: OllamaTool, cfg: PermissionsGateConfig): "allow" | "ask" | "deny" {
  switch (tool.permissionClass) {
    case "fs_read":
    case "fs_write":
      return cfg.permissions.fileSystem;
    case "shell":
      return cfg.permissions.shell;
    case "network":
      return cfg.permissions.network;
    case "git":
      return cfg.permissions.git;
    default:
      return "ask";
  }
}

export function gateToolCall(tool: OllamaTool, cfg: PermissionsGateConfig): GateDecision {
  const cls = tool.permissionClass;

  // fs_read is safe anywhere INSIDE the workspace. Outside is always a decision.
  if (cls === "fs_read") {
    if (cfg.pathInsideAllowlist) return { action: "execute" };
    return {
      action: "ask",
      kind: "permission",
      title: `Read outside workspace: ${tool.name}`,
      message: `${tool.name} is reading a path outside the house's workspace allowlist. Approve to continue.`,
    };
  }

  // fs_write: mutating. Inside → mode-dependent; outside → always a decision.
  if (cls === "fs_write") {
    if (!cfg.pathInsideAllowlist) {
      return {
        action: "ask",
        kind: "permission",
        title: `Write outside workspace: ${tool.name}`,
        message: `${tool.name} is writing outside the house's workspace allowlist. Approve to continue.`,
      };
    }
    return modeDecision(modeFor(tool, cfg), tool);
  }

  // Git: read-only ops follow the git mode; mutating ops ALWAYS ask (parity
  // with writes — a commit/push is a side effect that deserves a human).
  if (cls === "git") {
    if (tool.mutating && tool.name === "git") {
      return {
        action: "ask",
        kind: "permission",
        title: `Mutating git operation requested`,
        message: `The model requested a mutating git operation. Approve to continue, or the call will be denied.`,
      };
    }
    return modeDecision(modeFor(tool, cfg), tool);
  }

  // shell / network → pure mode gate.
  return modeDecision(modeFor(tool, cfg), tool);
}

function modeDecision(mode: "allow" | "ask" | "deny", tool: OllamaTool): GateDecision {
  switch (mode) {
    case "allow":
      return { action: "execute" };
    case "deny":
      return { action: "deny", reason: `${tool.name} is denied by the house's permission settings.` };
    default:
      return {
        action: "ask",
        kind: "permission",
        title: `Permission needed: ${tool.name}`,
        message: `The model wants to run '${tool.name}'. Approve to continue.`,
      };
  }
}

/**
 * The runtime uses this to check whether the approval policy allows silent
 * auto-execution for a gate that resolved to `allow` mode already.
 *
 * NOTE: for the Ollama loop, `approval_policy` only modulates the *ask* path:
 *  - `never`  → a gate that would otherwise `ask` (non-outside-allowlist) is
 *    auto-executed (no human bird).
 *  - `always` / `risky_only` → any `ask` becomes a real approval request.
 *  - out-of-allowlist is ALWAYS a real ask regardless of policy (safety).
 */
export function shouldAutoExecute(decision: GateDecision, cfg: PermissionsGateConfig): boolean {
  if (decision.action !== "ask") return false;
  // Out-of-allowlist safety override: never auto-execute.
  if (!cfg.pathInsideAllowlist) return false;
  if (cfg.approvalPolicy === "never") return true;
  return false;
}
