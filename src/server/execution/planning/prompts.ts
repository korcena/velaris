/**
 * Planning prompt builders (Phase 4 High Lord — §5.2 / §5.3).
 *
 * PURE module — string composition only. The system prompt template itself
 * lives in `HIGH_LORD_SEED.SYSTEM_PROMPT` (constants), editable by the user via
 * the standard house form; these builders append the per-run roster + contract
 * and compose the repair retry prompt. No DB imports.
 */

import { ORCHESTRATION_DEFAULTS } from "@/shared/constants";
import type { HouseDto } from "@/shared/types";

/** House roster entry — active agent houses the planner may delegate to. */
export interface RosterHouse {
  id: string;
  name: string;
  description: string | null;
  agentRole: string;
  model: string;
}

/** Build the roster block appended to the planning system prompt each run. */
export function composeRoster(roster: RosterHouse[]): string {
  if (!roster.length) {
    return "There are currently NO available execution houses to delegate to.";
  }
  const lines = roster.map(
    (h) =>
      `- id: ${h.id}\n  name: ${h.name}\n  role: ${h.agentRole}\n  model: ${h.model}\n  description: ${h.description ?? ""}`,
  );
  return `Available houses to delegate to:\n${lines.join("\n")}`;
}

/**
 * Compose the full per-run task prompt embedding the roster + strict JSON
 * contract + instruction. The system prompt (persona + JSON shape) is the
 * High Lord house's editable `systemPrompt`; this is appended as the task.
 */
export function composePlanningTaskPrompt(
  instruction: string,
  roster: RosterHouse[],
  maxSubtasks: number = ORCHESTRATION_DEFAULTS.MAX_SUBTASKS,
): string {
  const rosterBlock = composeRoster(roster);
  return [
    `# Instruction from the court\n${instruction}`,
    `# Houses available\n${rosterBlock}`,
    `# Constraints`,
    `- Decompose the instruction into at most ${maxSubtasks} subtasks.`,
    `- Assign each subtask to an available house via houseHints (or a specific houseId).`,
    `- Reply with STRICT JSON ONLY matching the schema in your system prompt.`,
  ].join("\n\n");
}

/** Repair prompt sent on the second (repair) planning attempt. */
export function composeRepairPrompt(error: string): string {
  return [
    "Your previous reply was NOT valid plan JSON.",
    `Validation error: ${error}`,
    "",
    "Reply with ONLY the corrected JSON object matching exactly the schema in your",
    "system prompt. No prose, no markdown fences.",
  ].join("\n");
}
