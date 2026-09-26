/**
 * Common zod schemas & helpers shared across resource schemas.
 */

import { z } from "zod";

/** A UUID (v4) identity string. */
export const uuidSchema = z
  .string()
  .uuid({ message: "Must be a valid UUID" });

/**
 * A non-empty string with surrounding whitespace trimmed. Optionally bounded
 * in length. Rejects strings that are only whitespace.
 */
export const trimmedNonEmpty = (max = 2000) =>
  z
    .string()
    .trim()
    .min(1, { message: "Must not be empty" })
    .max(max, { message: `Must be at most ${max} characters` });

/**
 * An absolute-path working directory, or `null` when the value is empty or
 * whitespace-only. A non-empty value MUST start with `/` — this mirrors the
 * `ck_tasks_working_dir_abs` DB CHECK so the failure surfaces as a friendly
 * 400 validation error instead of a raw SQLite constraint message.
 */
const absolutePathOrNull = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || v.startsWith("/"), {
    message: "Working directory must be an absolute path (starts with /)",
  });

/**
 * Create semantics: `undefined` / `null` / `""` / whitespace-only all normalize
 * to `null` (the field is unset); any other value must be absolute.
 */
export const absolutePathOrNullCreate = absolutePathOrNull
  .nullish()
  .transform((v) => v ?? null);

/**
 * Update (PATCH) semantics: `undefined` is preserved untouched so an omitted
 * field means "no change"; `null` / `""` / whitespace-only clear the value to
 * `null`; any other value must be absolute.
 */
export const absolutePathOrNullUpdate = absolutePathOrNull.nullable().optional();

/**
 * A JSON string containing an array of strings (e.g. stored allowlist / tools).
 * Accepts either a JSON-encoded string or a plain string[] for convenience;
 * always normalizes to a JSON string on output.
 */
export const jsonStringArray = z.union([
  z.string().transform((s, ctx) => {
    try {
      const parsed: unknown = JSON.parse(s);
      if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expected a JSON array of strings",
        });
        return z.NEVER;
      }
      return JSON.stringify(parsed);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid JSON",
      });
      return z.NEVER;
    }
  }),
  z.array(z.string()).transform((arr) => JSON.stringify(arr)),
]);

/**
 * A JSON string containing an object. Accepts either a JSON-encoded string or
 * a plain object; normalizes to a JSON string on output.
 */
export const jsonStringObject = z.union([
  z.string().transform((s, ctx) => {
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expected a JSON object",
        });
        return z.NEVER;
      }
      return JSON.stringify(parsed);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid JSON",
      });
      return z.NEVER;
    }
  }),
  z.record(z.string(), z.unknown()).transform((obj) => JSON.stringify(obj)),
]);

/** A JSON string containing a generic (possibly nested) object — read helper. */
export function parseJson<T = unknown>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
