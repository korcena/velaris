/**
 * Zod schemas for projects.
 */

import { z } from "zod";
import { uuidSchema, trimmedNonEmpty } from "./common";

const projectBase = z.object({
  name: trimmedNonEmpty(120),
  description: z.string().trim().max(3000).optional().default(""),
  directory: z
    .string()
    .trim()
    .min(1, { message: "Directory is required" })
    .refine((v) => v.startsWith("/"), {
      message: "Directory must be an absolute path (starts with /)",
    }),
  defaultModel: z.string().trim().optional().nullable().default(null),
  instructions: z.string().trim().optional().nullable().default(null),
});

export const projectCreateSchema = projectBase;

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = projectBase.partial();

export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

/** Internal DTO shape for the repository -> API layer (git_info is parsed). */
export const projectIdSchema = uuidSchema;
