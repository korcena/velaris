/**
 * Unit tests — quest soft-delete (task-repo).
 *
 * Covers the approved design (docs/superpowers/specs/2026-09-27-quest-soft-delete-design.md):
 *  - softDeleteTask sets deletedAt and leaves status untouched;
 *  - it throws TaskNotFoundError / TaskNotDeletableError (each active status);
 *  - it is idempotent;
 *  - restoreTask clears deletedAt (terminal unchanged) and flips queued → cancelled;
 *  - listTasks tri-state deleted filter (exclude/include/only);
 *  - getTask still returns deleted rows.
 *
 * Fresh temp DB per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, getRawDb, resetDbForTests } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import {
  createTask,
  getTask,
  listTasks,
  setTaskStatus,
  softDeleteTask,
  restoreTask,
  TaskNotFoundError,
  TaskNotDeletableError,
} from "@/server/repositories/task-repo";
import { createSubtask, linkChildTask } from "@/server/repositories/subtask-repo";
import { isTaskDeletable } from "@/shared/constants";
import type { TaskStatus } from "@/shared/types";

let tmpDir: string;

beforeEach(() => {
  resetDbForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velaris-softdelete-"));
  process.env.VELARIS_DB_PATH = path.join(tmpDir, "test.db");
  migrate();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.VELARIS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a task and force it into an arbitrary status (bypasses PATCH guard). */
function makeTaskWithStatus(status: TaskStatus): string {
  const task = createTask(getDb(), { title: `Task ${status}` });
  if (status !== "queued") setTaskStatus(getDb(), task.id, status);
  return task.id;
}

describe("softDeleteTask", () => {
  it("sets deletedAt, bumps updatedAt, and leaves status unchanged", () => {
    const id = makeTaskWithStatus("cancelled");
    const before = getTask(getDb(), id)!;

    const deleted = softDeleteTask(getDb(), id);

    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.status).toBe("cancelled"); // status never changes
    expect(deleted.updatedAt >= before.updatedAt).toBe(true);
    // Persisted.
    expect(getTask(getDb(), id)!.deletedAt).toBe(deleted.deletedAt);
  });

  it("is idempotent — a second delete returns the same row unchanged", () => {
    const id = makeTaskWithStatus("completed");
    const first = softDeleteTask(getDb(), id);
    const second = softDeleteTask(getDb(), id);
    expect(second.deletedAt).toBe(first.deletedAt);
    expect(second.status).toBe("completed");
  });

  it("throws TaskNotFoundError for an unknown id", () => {
    expect(() => softDeleteTask(getDb(), randomUUID())).toThrow(TaskNotFoundError);
  });

  it("throws TaskNotDeletableError for every active status", () => {
    for (const status of ["running", "awaiting_approval", "awaiting_input", "paused"] as const) {
      const id = makeTaskWithStatus(status);
      expect(isTaskDeletable(status)).toBe(false);
      expect(() => softDeleteTask(getDb(), id)).toThrow(TaskNotDeletableError);
      // The row is untouched.
      expect(getTask(getDb(), id)!.deletedAt).toBeNull();
    }
  });

  it("allows every deletable status (queued + terminal)", () => {
    for (const status of ["queued", "completed", "failed", "cancelled", "interrupted"] as const) {
      const id = makeTaskWithStatus(status);
      expect(isTaskDeletable(status)).toBe(true);
      const deleted = softDeleteTask(getDb(), id);
      expect(deleted.deletedAt).not.toBeNull();
      expect(deleted.status).toBe(status);
    }
  });

  it("TOCTOU: a concurrent queued→running claim yields TaskNotDeletableError and leaves deleted_at NULL", () => {
    // The task is ALREADY running in the real DB, but the initial read is made
    // to observe a stale 'queued' snapshot — simulating the engine claiming the
    // task after softDeleteTask's read but before its write. The conditional
    // UPDATE must match zero rows rather than stamping an active task deleted.
    const id = makeTaskWithStatus("running");
    const raw = getRawDb();
    const realRow = raw
      .prepare("SELECT status, deleted_at AS deletedAt FROM tasks WHERE id = ?")
      .get(id) as { status: string; deletedAt: string | null };

    let firstRead = true;
    const racyDb = {
      $client: raw,
      select: () => ({
        from: () => ({
          where: () => ({
            get: () => {
              if (firstRead) {
                firstRead = false;
                return { id, status: "queued", deletedAt: null };
              }
              return realRow;
            },
          }),
        }),
      }),
    } as unknown as Parameters<typeof softDeleteTask>[0];

    expect(() => softDeleteTask(racyDb, id)).toThrow(TaskNotDeletableError);

    // The atomic guard prevented the write: the task is untouched.
    const after = raw
      .prepare("SELECT status, deleted_at AS deletedAt FROM tasks WHERE id = ?")
      .get(id) as { status: string; deletedAt: string | null };
    expect(after.status).toBe("running");
    expect(after.deletedAt).toBeNull();
  });
});

describe("restoreTask", () => {
  it("clears deletedAt for a terminal task and leaves status unchanged", () => {
    const id = makeTaskWithStatus("failed");
    softDeleteTask(getDb(), id);

    const restored = restoreTask(getDb(), id);

    expect(restored.deletedAt).toBeNull();
    expect(restored.status).toBe("failed");
    expect(getTask(getDb(), id)!.deletedAt).toBeNull();
  });

  it("flips queued → cancelled on restore so it cannot silently execute", () => {
    const id = makeTaskWithStatus("queued");
    softDeleteTask(getDb(), id);

    const restored = restoreTask(getDb(), id);

    expect(restored.deletedAt).toBeNull();
    expect(restored.status).toBe("cancelled");
  });

  it("is idempotent — restoring a live task is a no-op", () => {
    const id = makeTaskWithStatus("completed");
    const restored = restoreTask(getDb(), id);
    expect(restored.deletedAt).toBeNull();
    expect(restored.status).toBe("completed");
  });

  it("throws TaskNotFoundError for an unknown id", () => {
    expect(() => restoreTask(getDb(), randomUUID())).toThrow(TaskNotFoundError);
  });
});

describe("listTasks deleted filter", () => {
  it("defaults to exclude, and include/only select the right rows", () => {
    const liveId = createTask(getDb(), { title: "live" }).id;
    const deletedId = createTask(getDb(), { title: "gone" }).id;
    softDeleteTask(getDb(), deletedId);

    const excluded = listTasks(getDb());
    expect(excluded.map((t) => t.id)).toContain(liveId);
    expect(excluded.map((t) => t.id)).not.toContain(deletedId);

    const included = listTasks(getDb(), { deleted: "include" });
    expect(included.map((t) => t.id)).toEqual(expect.arrayContaining([liveId, deletedId]));

    const only = listTasks(getDb(), { deleted: "only" });
    expect(only.map((t) => t.id)).toEqual([deletedId]);
  });

  it("getTask still returns a deleted row (restore + detail need it)", () => {
    const id = createTask(getDb(), { title: "gone" }).id;
    softDeleteTask(getDb(), id);
    const task = getTask(getDb(), id);
    expect(task).not.toBeNull();
    expect(task!.deletedAt).not.toBeNull();
  });
});

describe("listTasks parent filter", () => {
  it("defaults to roots — a linked child is hidden, its parent kept", () => {
    const parent = createTask(getDb(), { title: "parent" });
    const child = createTask(getDb(), { title: "child" });
    const s = createSubtask(getDb(), {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "step",
    });
    linkChildTask(getDb(), s.id, child.id);

    const ids = listTasks(getDb()).map((t) => t.id);
    expect(ids).toContain(parent.id);
    expect(ids).not.toContain(child.id);
  });

  it("parent: 'roots' matches; parent: 'all' returns both", () => {
    const parent = createTask(getDb(), { title: "parent" });
    const child = createTask(getDb(), { title: "child" });
    const s = createSubtask(getDb(), {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "step",
    });
    linkChildTask(getDb(), s.id, child.id);

    const roots = listTasks(getDb(), { parent: "roots" }).map((t) => t.id);
    expect(roots).toContain(parent.id);
    expect(roots).not.toContain(child.id);

    const all = listTasks(getDb(), { parent: "all" }).map((t) => t.id);
    expect(all).toEqual(expect.arrayContaining([parent.id, child.id]));
  });

  it("combined with deleted: include still respects the parent filter", () => {
    const parent = createTask(getDb(), { title: "parent" });
    const child = createTask(getDb(), { title: "child" });
    const s = createSubtask(getDb(), {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "step",
    });
    linkChildTask(getDb(), s.id, child.id);
    // A soft-deleted child must still be hidden under roots (the subtasks link
    // is what excludes it, regardless of the deleted filter).
    softDeleteTask(getDb(), child.id);

    const rootsInclude = listTasks(getDb(), { parent: "roots", deleted: "include" }).map((t) => t.id);
    expect(rootsInclude).not.toContain(child.id);

    const allInclude = listTasks(getDb(), { parent: "all", deleted: "include" }).map((t) => t.id);
    expect(allInclude).toEqual(expect.arrayContaining([parent.id, child.id]));
  });

  it("hides a retried-away child (orphaned by linkChildTask) via parentTaskId", () => {
    // Engine children carry execution_preferences.parentTaskId at creation; on
    // retry the subtask is re-pointed to a fresh child, leaving the old child
    // terminal, not deleted, and referenced by no subtask row. The board must
    // not resurface it as a top-level posting.
    const parent = createTask(getDb(), { title: "parent" });
    const c1 = createTask(getDb(), {
      title: "child v1",
      executionPreferences: { parentTaskId: parent.id },
    });
    const s = createSubtask(getDb(), {
      parentId: parent.id,
      planId: "s0",
      orderIndex: 0,
      dependsOn: [],
      title: "step",
    });
    linkChildTask(getDb(), s.id, c1.id);

    // Simulate the retry: fresh child, subtask re-pointed (old child orphaned).
    const c2 = createTask(getDb(), {
      title: "child v2",
      executionPreferences: { parentTaskId: parent.id },
    });
    linkChildTask(getDb(), s.id, c2.id);

    const roots = listTasks(getDb()).map((t) => t.id);
    expect(roots).toContain(parent.id);
    expect(roots).not.toContain(c1.id);
    expect(roots).not.toContain(c2.id);

    const all = listTasks(getDb(), { parent: "all" }).map((t) => t.id);
    expect(all).toEqual(expect.arrayContaining([parent.id, c1.id, c2.id]));
  });

  it("keeps a plain task with empty executionPreferences as a root", () => {
    const plain = createTask(getDb(), {
      title: "plain",
      executionPreferences: {},
    });
    expect(listTasks(getDb()).map((t) => t.id)).toContain(plain.id);
  });
});
