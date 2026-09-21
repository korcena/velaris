/**
 * Zod schemas for provider configs (OpenCode / Ollama endpoints).
 */

import { z } from "zod";
import { uuidSchema, trimmedNonEmpty } from "./common";

const providerConfigBase = z.object({
  name: trimmedNonEmpty(120),
  type: z.enum(["opencode", "ollama"]),
  baseUrl: z
    .string()
    .trim()
    .min(1, { message: "Base URL is required" })
    .refine((v) => /^https?:\/\//i.test(v), {
      message: "Base URL must start with http:// or https://",
    }),
  isDefault: z.boolean().default(false),
  extra: z.record(z.string(), z.unknown()).default({}),
});

export const providerConfigCreateSchema = providerConfigBase;

export type ProviderConfigCreateInput = z.infer<typeof providerConfigCreateSchema>;

/** Extra fields are merged; baseUrl/name/type/isDefault are replaceable. */
export const providerConfigUpdateSchema = providerConfigBase.partial();

export type ProviderConfigUpdateInput = z.infer<typeof providerConfigUpdateSchema>;

export const providerConfigIdSchema = uuidSchema;
