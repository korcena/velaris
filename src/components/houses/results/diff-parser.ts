/**
 * Pure diff artifact parser (Phase 3). React-free and tolerant of malformed
 * input.
 *
 * The engine joins diffs into a single TEXT blob (runner.ts persistTerminal):
 *   `${status} ${file}\n${patch}`  joined by  "\n---\n"
 * Each entry's first line is the status + file path; the remainder is the
 * unified diff patch (hunks + +/-/context lines).
 */

export interface DiffFileEntry {
  status: string;
  file: string;
  patch: string;
}

export type DiffLineKind = "add" | "del" | "hunk" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * Split an artifact blob into per-file DiffFileEntry objects.
 * Splits on the "\n---\n" separator; the first line of each chunk is treated
 * as "<status> <file>". Malformed chunks (empty / missing header line) are
 * skipped. Empty/invalid content → [].
 */
export function parseDiffArtifact(content: string): DiffFileEntry[] {
  if (!content || typeof content !== "string") return [];
  const chunks = content.split("\n---\n");
  const entries: DiffFileEntry[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    if (lines.length === 0) continue;
    const header = lines[0];
    if (!header || header.trim() === "") continue;
    const firstSpace = header.indexOf(" ");
    // A header without a space is treated as a bare filename (status defaults).
    const status = firstSpace >= 0 ? header.slice(0, firstSpace) : "modified";
    const file = firstSpace >= 0 ? header.slice(firstSpace + 1) : header;
    const patch = lines.slice(1).join("\n");
    entries.push({ status: status.trim() || "modified", file, patch });
  }

  return entries;
}

/**
 * Classify + parse a patch body into labelled diff lines.
 * "+" → add, "-" → del, "@@" → hunk (rendered as section headers), else
 * context. Tolerates malformed / empty patches → [].
 */
export function parsePatch(patch: string): DiffLine[] {
  if (!patch || typeof patch !== "string") return [];
  const input = patch.replace(/^\n/, ""); // drop a stray leading newline
  if (input.trim() === "") return [];
  const lines = input.split("\n");
  const out: DiffLine[] = [];
  for (const line of lines) {
    if (line.startsWith("+")) {
      out.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", text: line });
    } else if (line.startsWith("@@")) {
      out.push({ kind: "hunk", text: line });
    } else {
      out.push({ kind: "context", text: line });
    }
  }
  return out;
}
