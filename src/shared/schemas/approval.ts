/**
 * Zod schemas for approval requests — the messenger-bird flow.
 *
 * Approval resolution is user-driven via POST /api/approvals/{id}/respond.
 * The engine relays the chosen action to the OpenCode provider asynchronously.
 */

import { z } from "zod";
import { uuidSchema } from "./common";

/** Actions the user can take on an approval request (AGENT_ORCHESTRATION §5). */
const APPROVE_ACTIONS = ["approve", "reject", "reply", "select"] as const;

/**
 * POST /api/approvals/{id}/respond body.
 *  - approve:   grant a permission (or accept a question) → no response text
 *               (the provider derives "allow").
 *  - reject:    deny a permission / reject a question; optional message.
 *  - reply:     free-text answer (for questions) or deny-with-guidance (for
 *               permissions). `response` is required.
 *  - select:    choose one of the question's options by id (`optionId`).
 */
export const approvalRespondSchema = z.object({
  action: z.enum(APPROVE_ACTIONS),
  response: z.string().trim().max(4000).optional().nullable(),
  optionId: z.string().trim().max(200).optional().nullable(),
});

export type ApprovalRespondInput = z.infer<typeof approvalRespondSchema>;

/** GET /api/approvals?status=pending filter — an optional approval status. */
export const approvalStatusQuerySchema = z
  .enum(["pending", "approved", "rejected", "replied", "cancelled"])
  .optional();

/** Route param id validation for /api/approvals/{id}. */
export const approvalIdSchema = uuidSchema;
