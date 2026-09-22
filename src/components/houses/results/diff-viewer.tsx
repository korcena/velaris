"use client";

/**
 * Diff viewer (Phase 3) — renders a raw diff artifact blob with syntax-ish
 * highlighting (no diff library). Each file is a collapsible block headed by a
 * status badge and the monospace file path.
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { parseDiffArtifact, parsePatch, type DiffLine } from "./diff-parser";

function lineClass(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "bg-velaris-teal/10 text-velaris-teal";
    case "del":
      return "bg-velaris-crimson/10 text-velaris-crimson";
    case "hunk":
      return "text-muted-foreground bg-velaris-purple-deep/20";
    default:
      return "text-velaris-silver";
  }
}

export function DiffViewer({ content }: { content: string }) {
  const entries = parseDiffArtifact(content);

  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No file changes were recorded for this quest.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry, i) => (
        <DiffFile key={`${entry.file}-${i}`} status={entry.status} file={entry.file} patch={entry.patch} />
      ))}
    </div>
  );
}

function DiffFile({
  status,
  file,
  patch,
}: {
  status: string;
  file: string;
  patch: string;
}) {
  const [open, setOpen] = useState(true);
  const lines = parsePatch(patch);
  const stats = {
    add: lines.filter((l) => l.kind === "add").length,
    del: lines.filter((l) => l.kind === "del").length,
  };

  return (
    <div className="rounded-lg border border-border bg-card/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className={cn("transition-transform", open && "rotate-90")}>▸</span>
        <Badge variant="outline">{status}</Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{file}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          <span className="text-velaris-teal">+{stats.add}</span>{" "}
          <span className="text-velaris-crimson">-{stats.del}</span>
        </span>
      </button>

      {open ? (
        <div className="overflow-x-auto border-t border-border/60">
          <pre className="whitespace-pre py-1 font-mono text-xs leading-relaxed">
            {lines.map((line, idx) => (
              <div key={idx} className={cn("px-3", lineClass(line.kind))}>
                {line.text === "" ? " " : line.text}
              </div>
            ))}
            {lines.length === 0 ? (
              <div className="px-3 text-muted-foreground">(no patch body)</div>
            ) : null}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
