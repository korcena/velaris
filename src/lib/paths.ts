/**
 * Workspace path safety (ARCHITECTURE §8 / §9).
 *
 * `resolveSafePath()` validates a candidate path against an allowlist:
 *   1. path.resolve → absolute normalize
 *   2. fs.realpath   → defeats ../ and symlink escapes
 *   3. prefix match  → result must be inside (equal to) an allowlist entry
 *
 * Enforced at runtime in Phase 2+; the logic is unit-tested now (Phase 1).
 */

import path from "node:path";
import fs from "node:fs";

/** Ensure a path is absolute; if not, resolve it against cwd. */
export function toAbsolute(candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
}

/**
 * Whether `candidate` is an absolute path string (before resolution). Used for
 * early user feedback in forms.
 */
export function isAbsolutePath(candidate: string): boolean {
  return candidate.startsWith("/");
}

/**
 * Validate that `candidate` (after resolution + realpath) is inside (or
 * equal to) one of the `allowlist` entries. Returns the safe real path on
 * success; throws a descriptive Error on any failure.
 *
 * @param candidate The path to validate (absolute or relative).
 * @param allowlist Entries to allow; each resolved via realpath if it exists.
 * @throws Error when the path is outside the allowlist, does not exist (realpath), or no allowlist exists.
 */
export function resolveSafePath(
  candidate: string,
  allowlist: string[],
): string {
  if (!allowlist.length) {
    throw new Error("Allowlist is empty — no directory is permitted");
  }

  // 1. Absolute-normalize the candidate.
  const abs = toAbsolute(candidate);

  // 2. realpath: resolves symlinks and `..`, requiring existence.
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(abs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(`Path does not exist or cannot be resolved: ${abs} (${e.code ?? "error"})`);
  }

  // Build a realpath'd allowlist (skip entries that don't exist — they can't be allowed).
  const resolved = allowlist
    .map((entry) => {
      const absEntry = toAbsolute(entry);
      try {
        return fs.realpathSync(absEntry);
      } catch {
        return null;
      }
    })
    .filter((v): v is string => v !== null);

  if (!resolved.length) {
    throw new Error("None of the allowlist entries resolve to an existing directory");
  }

  // 3. Prefix containment (path-segment aware).
  for (const entry of resolved) {
    if (realCandidate === entry || realCandidate.startsWith(entry + path.sep)) {
      return realCandidate;
    }
  }

  throw new Error(
    `Path '${realCandidate}' is outside the permitted workspace allowlist`,
  );
}

/** Convenience: does `candidate` survive `resolveSafePath` against `allowlist`? */
export function isPathAllowed(candidate: string, allowlist: string[]): boolean {
  try {
    resolveSafePath(candidate, allowlist);
    return true;
  } catch {
    return false;
  }
}
