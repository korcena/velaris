/**
 * Tool registry — build the active tool set for a house (Phase 5 Stage D).
 *
 * Selection rule (decision Q6):
 *  - `tools` list on the house config ("fs", "shell", "git"…) selects the tool
 *    families.
 *  - `web_fetch` is a special case: it is ONLY registered when the house
 *    explicitly allows network (`permissions.network === 'allow'`) — regardless
 *    of the tools list. A network-denied house never even exposes the tool to the
 *    model.
 *  - `git` registers the read/write git tool; git mutating ops remain approval
 *    gated (Stage E).
 *
 * `toOllamaToolDefs` emits the `tools[]` array for the `/api/chat` request.
 */

import type { HouseConfiguration } from "@/shared/types";
import { fsRead, fsList, fsWrite } from "./fs";
import { shellExec } from "./shell";
import { webFetch } from "./web-fetch";
import { git, gitStatus, gitDiff } from "./git";
import type { OllamaTool } from "./types";

export interface ToolRegistryOptions {
  tools: string[];
  permissions: HouseConfiguration["permissions"];
}

const FAMILY_TOOLS: Record<string, OllamaTool[]> = {
  fs: [fsRead, fsList, fsWrite],
  shell: [shellExec],
  git: [git, gitStatus, gitDiff],
  network: [], // resolved separately via the network permission gate
};

/** Build the active tool set for a house. */
export function buildToolRegistry(opts: ToolRegistryOptions): OllamaTool[] {
  const tools: OllamaTool[] = [];
  const wanted = new Set(opts.tools ?? []);

  if (wanted.has("fs")) tools.push(...FAMILY_TOOLS.fs);
  if (wanted.has("shell")) tools.push(...FAMILY_TOOLS.shell);
  if (wanted.has("git")) tools.push(...FAMILY_TOOLS.git);

  // Network is opt-in per-house: only present when explicitly allowed.
  if (opts.permissions.network === "allow") {
    tools.push(webFetch);
  }

  return tools;
}

/** Build the Ollama `/api/chat` tools[] payload from the active tool set. */
export function toOllamaToolDefs(tools: OllamaTool[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export type { OllamaTool };
