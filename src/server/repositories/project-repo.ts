/**
 * Project repository — CRUD with a unique-directory check and git info
 * auto-detection at registration.
 */

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import type { VelarisDb } from "@/lib/db";
import { rawDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { parseJson } from "@/shared/schemas/common";
import type { ProjectDto, ProjectGitInfo } from "@/shared/types";

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project not found: ${id}`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectDirectoryExistsError extends Error {
  constructor(dir: string) {
    super(`A project with directory '${dir}' already exists`);
    this.name = "ProjectDirectoryExistsError";
  }
}

export class ProjectHasTasksError extends Error {
  constructor(id: string) {
    super(`Project has referencing tasks and cannot be deleted: ${id}`);
    this.name = "ProjectHasTasksError";
  }
}

export class ProjectDirectoryInvalidError extends Error {
  constructor(dir: string, reason: string) {
    super(`Invalid project directory '${dir}': ${reason}`);
    this.name = "ProjectDirectoryInvalidError";
  }
}

/** Validate that a directory is absolute, exists, and is a readable directory. */
export function assertValidDirectory(directory: string): void {
  if (!directory.startsWith("/")) {
    throw new ProjectDirectoryInvalidError(directory, "path must be absolute");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    throw new ProjectDirectoryInvalidError(directory, "directory does not exist");
  }
  if (!stat.isDirectory()) {
    throw new ProjectDirectoryInvalidError(directory, "path is not a directory");
  }
}

/* ------------------------------ Mapping ----------------------------- */

export function projectRowToDto(row: (typeof projects.$inferSelect)): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    directory: row.directory,
    gitInfo: parseJson<ProjectGitInfo>(row.gitInfo, {
      branch: null,
      remote: null,
      dirty: false,
    }),
    defaultAgentId: row.defaultAgentId ?? null,
    defaultModel: row.defaultModel ?? null,
    instructions: row.instructions ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function gitInfoForDir(directory: string): ProjectGitInfo {
  // Best-effort git detection via the git CLI. Non-fatal on failure.
  const run = (args: string, fallback: string | null): string | null => {
    try {
      return execSync(`git -C "${directory}" ${args}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split("\n")[0] || fallback;
    } catch {
      return fallback;
    }
  };

  // Is this a git repo at all?
  try {
    execSync(`git -C "${directory}" rev-parse --is-inside-work-tree`, {
      stdio: "ignore",
    });
  } catch {
    return { branch: null, remote: null, dirty: false };
  }

  const branch = run("rev-parse --abbrev-ref HEAD", null);
  const remote = run("remote get-url origin", null);
  const porcelain = run("status --porcelain", "");
  const dirty = porcelain !== null && porcelain.trim().length > 0;

  return { branch, remote, dirty };
}

/* ------------------------------ Reading ----------------------------- */

export function listProjects(db: VelarisDb): ProjectDto[] {
  return db
    .select()
    .from(projects)
    .orderBy(projects.createdAt)
    .all()
    .map(projectRowToDto);
}

export function getProject(db: VelarisDb, id: string): ProjectDto | null {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  return row ? projectRowToDto(row) : null;
}

/** Throws ProjectDirectoryExistsError if any row already uses this directory. */
export function assertDirectoryUnique(db: VelarisDb, directory: string): void {
  const row = db
    .select()
    .from(projects)
    .where(eq(projects.directory, directory))
    .get();
  if (row) throw new ProjectDirectoryExistsError(directory);
}

/* ------------------------------ Writing ----------------------------- */

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string | null;
  directory: string;
  defaultModel?: string | null;
  instructions?: string | null;
  /** Auto-detected; overridable by callers/tests. */
  gitInfo?: ProjectGitInfo;
}

export function createProject(db: VelarisDb, input: CreateProjectInput): ProjectDto {
  assertValidDirectory(input.directory);
  assertDirectoryUnique(db, input.directory);

  const id = input.id ?? randomUUID();
  const gitInfo = input.gitInfo ?? gitInfoForDir(input.directory);

  db.insert(projects)
    .values({
      id,
      name: input.name,
      description: input.description ?? "",
      directory: input.directory,
      gitInfo: JSON.stringify(gitInfo),
      defaultModel: input.defaultModel ?? null,
      instructions: input.instructions ?? null,
    })
    .run();

  return getProject(db, id)!;
}

export type UpdateProjectPatch = {
  name?: string;
  description?: string | null;
  directory?: string;
  defaultModel?: string | null;
  instructions?: string | null;
};

/** Merge partial updates. Directory changes re-validate uniqueness + git info. */
export function updateProject(
  db: VelarisDb,
  id: string,
  patch: UpdateProjectPatch,
): ProjectDto {
  const existing = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!existing) throw new ProjectNotFoundError(id);

  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description ?? "";
  if (patch.directory !== undefined) {
    if (patch.directory !== existing.directory) {
      assertValidDirectory(patch.directory);
      assertDirectoryUnique(db, patch.directory);
      set.directory = patch.directory;
      set.gitInfo = JSON.stringify(gitInfoForDir(patch.directory));
    }
  }
  if (patch.defaultModel !== undefined) set.defaultModel = patch.defaultModel ?? null;
  if (patch.instructions !== undefined) set.instructions = patch.instructions ?? null;
  if (Object.keys(set).length) {
    set.updatedAt = new Date().toISOString();
    db.update(projects).set(set).where(eq(projects.id, id)).run();
  }
  return getProject(db, id)!;
}

/** Delete a project; blocked if any task references it. */
export function deleteProject(db: VelarisDb, id: string): void {
  const existing = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!existing) throw new ProjectNotFoundError(id);

  const hasTasks = rawDb(db)
    .prepare(`SELECT EXISTS(SELECT 1 FROM tasks WHERE project_id = ?) AS e`)
    .get(id) as { e: 0 | 1 };
  if (hasTasks.e === 1) throw new ProjectHasTasksError(id);

  db.delete(projects).where(eq(projects.id, id)).run();
}
