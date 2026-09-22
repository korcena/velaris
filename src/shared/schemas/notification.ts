/**
 * Zod schemas for notifications (messenger roost feed).
 */

import { z } from "zod";
import { uuidSchema } from "./common";

/** POST /api/notifications/{id}/read → 200; body is not required. */
export const notificationReadSchema = z.object({
  read: z.boolean().optional().default(true),
});

/** GET /api/notifications?unreadOnly=0|1 — optional filter. */
export const notificationsQuerySchema = z.object({
  unreadOnly: z
    .enum(["0", "1"])
    .optional()
    .transform((v) => (v === "1" ? true : v === "0" ? false : undefined)),
});

/** Route param id validation. */
export const notificationIdSchema = uuidSchema;

/** POST /api/houses/{id}/messages body — send a message to the house's active session. */
export const houseMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, { message: "Message must not be empty" })
    .max(8000, { message: "Message too long" }),
});

export type HouseMessageInput = z.infer<typeof houseMessageSchema>;
