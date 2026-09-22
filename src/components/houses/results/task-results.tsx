"use client";

/**
 * Task results (Phase 3) — surfaces a house's finished quests and their
 * artifacts. Defaults to the latest completed task (else the latest candidate),
 * then shows that quest's artifacts grouped by kind:
 *   diff → <DiffViewer>, result → prose card, file_list → mono list,
 *   other → crimson error card.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/api-client";
import type { TaskDto, ArtifactDto } from "@/shared/types";
import { DiffViewer } from "./diff-viewer";

interface TaskResultsProps {
  houseId: string;
  /** Bump (e.g. realtime sequence) to refetch. */
  refreshKey?: unknown;
}

export function TaskResults({ houseId, refreshKey }: TaskResultsProps) {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch all house tasks, then narrow to finishable candidates locally.
      const res = await apiFetch<{ tasks: TaskDto[] }>(`/api/tasks?houseId=${houseId}`);
      const candidates = res.tasks.filter(
        (t) => t.status === "completed" || t.status === "failed",
      );
      setTasks(candidates);
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [houseId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Default to the latest completed task.
  useEffect(() => {
    if (tasks.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !tasks.some((t) => t.id === selectedId)) {
      setSelectedId(tasks[0].id);
    }
  }, [tasks, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setArtifacts([]);
      return;
    }
    let alive = true;
    apiFetch<{ artifacts: ArtifactDto[] }>(`/api/tasks/${selectedId}/artifacts`)
      .then((res) => alive && setArtifacts(res.artifacts))
      .catch(() => alive && setArtifacts([]));
    return () => {
      alive = false;
    };
  }, [selectedId, refreshKey]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  if (loading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading quest results…</p>;
  }

  if (tasks.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        This house has no finished quests yet.
      </p>
    );
  }

  const diffArtifacts = artifacts.filter((a) => a.kind === "diff");
  const resultArtifacts = artifacts.filter((a) => a.kind === "result");
  const fileListArtifacts = artifacts.filter((a) => a.kind === "file_list");
  const otherArtifacts = artifacts.filter((a) => a.kind === "other");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select value={selectedId ?? undefined} onValueChange={setSelectedId}>
          <SelectTrigger className="w-full max-w-sm">
            <SelectValue placeholder="Select a quest" />
          </SelectTrigger>
          <SelectContent>
            {tasks.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.title ?? "Untitled quest"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge variant="outline">{tasks.length} quests</Badge>
      </div>

      {selectedTask ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{selectedTask.title ?? "Untitled quest"}</span>{" "}
          · <span className={selectedTask.status === "failed" ? "text-velaris-crimson" : "text-foreground"}>{selectedTask.status ?? "finished"}</span>
        </p>
      ) : null}

      {artifacts.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          This quest left no scrolls behind.
        </p>
      ) : (
        <div className="space-y-4">
          {diffArtifacts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="font-serif-display text-lg">File changes</CardTitle>
              </CardHeader>
              <CardContent>
                <DiffViewer key={diffArtifacts.map((a) => a.id).join(",")} content={diffArtifacts.map((a) => a.content).join("\n---\n")} />
              </CardContent>
            </Card>
          )}

          {resultArtifacts.map((a) => (
            <Card key={a.id}>
              <CardHeader>
                <CardTitle className="font-serif-display text-lg">Result</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-foreground">{a.content}</p>
              </CardContent>
            </Card>
          ))}

          {fileListArtifacts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="font-serif-display text-lg">Files touched</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  {fileListArtifacts.map((a) => (
                    <p
                      key={a.id}
                      className="truncate rounded bg-black/20 px-2 py-1 font-mono text-xs text-muted-foreground"
                    >
                      {a.content}
                    </p>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {otherArtifacts.map((a) => (
            <Card key={a.id} className="border-velaris-crimson/40">
              <CardHeader>
                <CardTitle className="font-serif-display text-lg text-velaris-crimson">
                  Failed / note
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-velaris-crimson">{a.content}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
