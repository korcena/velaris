/**
 * Zod schemas for execution-facing query params (stream cursor, events afterId).
 * Single source of validation for the read-side cursors used by /api/stream and
 * /api/tasks/{id}/events.
 */

import { z } from "zod";

/**
 * A non-negative integer cursor (execution_events.id is INTEGER autoincrement).
 * Accepts an empty string / absent value as "no cursor" (undefined).
 */
export const eventCursorSchema = z
  .string()
  .trim()
  .optional()
  .transform((v) => {
    if (!v || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  });

/** Query params for GET /api/stream (event cursor only). */
export const streamQuerySchema = z.object({
  lastEventId: eventCursorSchema,
});

/** Query params for GET /api/tasks/{id}/events (optional afterId cursor). */
export const taskEventsQuerySchema = z.object({
  afterId: eventCursorSchema,
});

export type TaskEventsQueryInput = z.infer<typeof taskEventsQuerySchema>;
