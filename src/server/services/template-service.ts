/**
 * Template service (Phase 6 Stage C) — zod validation at the API boundary plus
 * instantiation of a fully configured house/project from a template.
 *
 * Instantiation is the §10 acceptance criterion: "a template instantiates a
 * fully configured house". It runs the SAME schemas/repo validation as normal
 * creation (no bypass — templates create mis-configured houses risk register
 * §16.8):
 *  - house: merge the template payload with instantiation overrides
 *    (name/agent name) and validate with `houseCreateSchema`, then `createHouse`;
 *  - project: template payload + required `directory`, then `createProject`
 *    which runs `assertValidDirectory` + `assertDirectoryUnique`.
 *
 * All template CRUD + instantiation writes a Q9 audit row.
 */

import { randomUUID } from "node:crypto";
import type { VelarisDb } from "@/lib/db";
import {
  templateCreateSchema,
  templateUpdateSchema,
  houseTemplatePayloadSchema,
  projectTemplatePayloadSchema,
  type TemplateCreateInput,
  type TemplateUpdateInput,
} from "@/shared/schemas/template";
import { houseCreateSchema } from "@/shared/schemas/house";
import { projectCreateSchema } from "@/shared/schemas/project";
import {
  listTemplates as repoList,
  getTemplate as repoGet,
  createTemplate as repoCreate,
  updateTemplate as repoUpdate,
  deleteTemplate as repoDelete,
  TemplateNotFoundError,
  SeededTemplateError,
  TemplateNameExistsError,
} from "@/server/repositories/template-repo";
import { createHouse as repoCreateHouse } from "@/server/repositories/house-repo";
import { createProject as repoCreateProject } from "@/server/repositories/project-repo";
import { recordAudit } from "@/server/repositories/audit-repo";
import type {
  TemplateDto,
  TemplateKind,
  HouseDto,
  ProjectDto,
  HouseTemplatePayload,
  ProjectTemplatePayload,
} from "@/shared/types";

export { TemplateNotFoundError, SeededTemplateError, TemplateNameExistsError };

/** Payload supplied at instantiation may override a few template fields. */
export interface InstantiateHouseOverrides {
  /** House name; defaults to the template name when omitted. */
  name?: string;
  /** Agent name; defaults to the template's agent name when omitted. */
  agentName?: string;
}

export interface InstantiateProjectOverrides {
  /** Project name; defaults to the template name when omitted. */
  name?: string;
  /** REQUIRED — supplied at instantiation, validated by createProject. */
  directory: string;
}

/* ------------------------------- CRUD ------------------------------- */

export function listTemplatesService(db: VelarisDb, kind?: TemplateKind): TemplateDto[] {
  return repoList(db, { kind });
}

export function getTemplateService(db: VelarisDb, id: string): TemplateDto | null {
  return repoGet(db, id);
}

export function createTemplateService(db: VelarisDb, input: unknown): TemplateDto {
  const parsed: TemplateCreateInput = templateCreateSchema.parse(input);
  const template = repoCreate(db, {
    id: randomUUID(),
    kind: parsed.kind,
    name: parsed.name,
    description: parsed.description ?? "",
    payload: parsed.payload,
    isSeeded: false,
  });
  recordAudit(db, {
    actor: "user",
    action: "create",
    entityType: "template",
    entityId: template.id,
    metadata: { kind: template.kind, name: template.name },
  });
  return template;
}

export function updateTemplateService(
  db: VelarisDb,
  id: string,
  input: unknown,
): TemplateDto {
  const parsed: TemplateUpdateInput = templateUpdateSchema.parse(input);
  const existing = repoGet(db, id);
  if (!existing) throw new TemplateNotFoundError(id);

  // The payload shape must match the template's kind (the update schema accepts
  // either shape because `kind` is immutable and not part of the patch).
  let payload = parsed.payload as HouseTemplatePayload | ProjectTemplatePayload | undefined;
  if (payload !== undefined) {
    payload =
      existing.kind === "house"
        ? houseTemplatePayloadSchema.parse(payload)
        : projectTemplatePayloadSchema.parse(payload);
  }

  const template = repoUpdate(db, id, {
    name: parsed.name,
    description: parsed.description,
    payload,
  });
  recordAudit(db, {
    actor: "user",
    action: "update",
    entityType: "template",
    entityId: template.id,
    metadata: {
      kind: template.kind,
      changed: [
        ...(parsed.name !== undefined ? ["name"] : []),
        ...(parsed.description !== undefined ? ["description"] : []),
        ...(parsed.payload !== undefined ? ["payload"] : []),
      ],
    },
  });
  return template;
}

export function deleteTemplateService(db: VelarisDb, id: string): void {
  const existing = repoGet(db, id);
  repoDelete(db, id);
  recordAudit(db, {
    actor: "user",
    action: "delete",
    entityType: "template",
    entityId: id,
    metadata: { kind: existing?.kind ?? null, name: existing?.name ?? null },
  });
}

/* ---------------------------- Instantiation ------------------------- */

/**
 * Instantiate a fully configured house from a house template. The merged payload
 * is validated with the SAME `houseCreateSchema` as normal creation, so a
 * template can never produce a house that the API would otherwise reject.
 */
export function instantiateHouseTemplate(
  db: VelarisDb,
  templateId: string,
  overrides: InstantiateHouseOverrides = {},
): HouseDto {
  const template = repoGet(db, templateId);
  if (!template) throw new TemplateNotFoundError(templateId);
  if (template.kind !== "house") {
    throw new TemplateKindMismatchError(templateId, "house", template.kind);
  }

  const payload = houseTemplatePayloadSchema.parse(template.payload);
  const merged = {
    name: overrides.name ?? template.name,
    description: payload.description,
    agent: {
      name: overrides.agentName ?? payload.agent.name,
      role: payload.agent.role,
    },
    configuration: payload.configuration,
  };
  // Same strict schema as POST /api/houses — no validation bypass.
  const parsed = houseCreateSchema.parse(merged);

  const house = repoCreateHouse(db, {
    id: randomUUID(),
    name: parsed.name,
    description: parsed.description ?? "",
    agent: parsed.agent,
    configuration: parsed.configuration,
  });
  recordAudit(db, {
    actor: "user",
    action: "instantiate",
    entityType: "house",
    entityId: house.id,
    metadata: { templateId, templateName: template.name, name: house.name },
  });
  return house;
}

/**
 * Instantiate a project from a project template. The directory is REQUIRED at
 * instantiation (Q4) and validated by `createProject`'s existing
 * `assertValidDirectory` / `assertDirectoryUnique`. Allowlists are not templated.
 */
export function instantiateProjectTemplate(
  db: VelarisDb,
  templateId: string,
  overrides: InstantiateProjectOverrides,
): ProjectDto {
  const template = repoGet(db, templateId);
  if (!template) throw new TemplateNotFoundError(templateId);
  if (template.kind !== "project") {
    throw new TemplateKindMismatchError(templateId, "project", template.kind);
  }

  const payload = projectTemplatePayloadSchema.parse(template.payload);
  const merged = {
    name: overrides.name ?? template.name,
    description: payload.description,
    directory: overrides.directory,
    defaultModel: payload.defaultModel,
    instructions: payload.instructions,
  };
  const parsed = projectCreateSchema.parse(merged);

  const project = repoCreateProject(db, {
    name: parsed.name,
    description: parsed.description ?? "",
    directory: parsed.directory,
    defaultModel: parsed.defaultModel,
    instructions: parsed.instructions,
  });
  recordAudit(db, {
    actor: "user",
    action: "instantiate",
    entityType: "project",
    entityId: project.id,
    metadata: { templateId, templateName: template.name, name: project.name },
  });
  return project;
}

/** Thrown when a template's kind does not match the requested instantiation. */
export class TemplateKindMismatchError extends Error {
  constructor(id: string, expected: TemplateKind, actual: TemplateKind) {
    super(`Template ${id} is a ${actual} template, expected ${expected}`);
    this.name = "TemplateKindMismatchError";
  }
}
