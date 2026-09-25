/**
 * Shared helpers for API route handlers — consistent JSON responses and
 * Zod/repo error mapping per ARCHITECTURE §7:
 *   400 validation (ZodError) · 404 missing · 409 conflict · 422 bad transition.
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  HouseNotFoundError,
  InvalidStatusTransitionError,
  HouseNotArchivedError,
  HighLordTransitionError,
} from "@/server/services/house-service";
import { ProjectNotFoundError, ProjectDirectoryExistsError, ProjectHasTasksError, ProjectDirectoryInvalidError } from "@/server/repositories/project-repo";
import { ProviderConfigNotFoundError } from "@/server/repositories/provider-config-repo";
import { TaskNotFoundError, InvalidTaskStatusTransitionError } from "@/server/repositories/task-repo";
import {
  TemplateNotFoundError,
  SeededTemplateError,
  TemplateNameExistsError,
} from "@/server/repositories/template-repo";
import { TemplateKindMismatchError } from "@/server/services/template-service";

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function created<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 201 });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

export function badRequest(message: string, issues?: unknown): NextResponse {
  return NextResponse.json({ error: message, issues }, { status: 400 });
}

export function notFound(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function conflict(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 409 });
}

export function badTransition(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 422 });
}

/**
 * Map an arbitrary thrown error to the correct HTTP response.
 * Handles zod + known repo exceptions; maps SQLite constraint failures to
 * 400 (invalid reference or value); falls back to a 500.
 */
export function routeError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return badRequest("Validation failed", err.issues);
  }
  if (err instanceof HouseNotFoundError || err instanceof ProjectNotFoundError ||
      err instanceof ProviderConfigNotFoundError || err instanceof TaskNotFoundError ||
      err instanceof TemplateNotFoundError) {
    return notFound(err.message);
  }
  if (err instanceof ProjectDirectoryExistsError || err instanceof ProjectHasTasksError ||
      err instanceof SeededTemplateError || err instanceof TemplateNameExistsError) {
    return conflict(err.message);
  }
  if (err instanceof ProjectDirectoryInvalidError) {
    return badRequest(err.message);
  }
  if (err instanceof TemplateKindMismatchError) {
    return badRequest(err.message);
  }
  if (err instanceof HouseNotArchivedError) {
    return conflict(err.message);
  }
  if (err instanceof InvalidStatusTransitionError || err instanceof InvalidTaskStatusTransitionError || err instanceof HighLordTransitionError) {
    return badTransition(err.message);
  }
  // SQLite constraint failures (FK references to nonexistent rows, CHECK
  // violations on enum/absolute-path columns) are client-input problems —
  // surface them as 400 rather than an opaque 500.
  const sqliteErr = err as { code?: unknown; message?: unknown };
  if (
    typeof sqliteErr.code === "string" &&
    sqliteErr.code.startsWith("SQLITE_CONSTRAINT") &&
    typeof sqliteErr.message === "string"
  ) {
    return badRequest(sqliteErr.message);
  }
  console.error("[velaris] Unhandled route error:", err);
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 },
  );
}

/** Parse a JSON request body; on failure returns a 400 response or throws. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new MapError(badRequest("Request body must be valid JSON"));
  }
}

class MapError extends Error {
  response: NextResponse;
  constructor(response: NextResponse) {
    super("Mapped error");
    this.response = response;
  }
}

/** Throw an already-built response (caught by a route that calls routeError). */
export function failWith(response: NextResponse): never {
  throw new MapError(response);
}

/** Wrap routeError to also honour mapped responses. */
export function routeErrorOrMapped(err: unknown): NextResponse {
  if (err instanceof MapError) return err.response;
  return routeError(err);
}
