/**
 * Platform-agnostic path helpers (imported by BOTH client and server).
 * No Node.js imports here so these are safe for client components.
 */

/** Whether `candidate` is an absolute path string (starts with '/'). */
export function isAbsolutePath(candidate: string): boolean {
  return candidate.startsWith("/");
}
