import type { Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import { ActorType, AuditEventType } from "@/generated/prisma/client";
import type { PrismaTransaction } from "@/lib/db";
import { decideActivation } from "@/lib/specs/revision-decisions";

type Db = PrismaClient | PrismaTransaction;

export type RegisterApiSpecInput = {
  workspaceId: string;
  apiKey: string;
  environment?: string;
  name: string;
  version: string;
  openApiVersion: string;
  sourceFilename: string;
  sourceText: string;
  sourceSha256: string;
  parsedDocument: Prisma.InputJsonValue;
  provenance?: Prisma.InputJsonValue | null;
  activate?: boolean;
};

export class SpecActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecActivationError";
  }
}

export async function registerApiSpec(
  db: PrismaClient,
  input: RegisterApiSpecInput,
) {
  return db.$transaction(async (tx) => {
    const environment = input.environment ?? "default";
    await tx.$queryRaw`
      SELECT "id" FROM "api_specs"
      WHERE "workspace_id" = ${input.workspaceId}::uuid
        AND "api_key" = ${input.apiKey}
        AND "environment" = ${environment}
      ORDER BY "revision_sequence" DESC
      LIMIT 1
      FOR UPDATE
    `;
    const latest = await tx.apiSpec.findFirst({
      where: { workspaceId: input.workspaceId, apiKey: input.apiKey, environment },
      orderBy: { revisionSequence: "desc" },
      select: { revisionSequence: true },
    });
    const spec = await tx.apiSpec.create({
      data: {
        workspaceId: input.workspaceId,
        apiKey: input.apiKey,
        environment,
        name: input.name,
        version: input.version,
        openApiVersion: input.openApiVersion,
        sourceFilename: input.sourceFilename,
        sourceText: input.sourceText,
        sourceSha256: input.sourceSha256,
        parsedDocument: input.parsedDocument,
        provenance: input.provenance ?? undefined,
        revisionSequence: (latest?.revisionSequence ?? 0) + 1,
        isActive: false,
      },
    });

    await appendAuditLog(tx, {
      workspaceId: input.workspaceId,
      eventType: AuditEventType.SPEC_REGISTERED,
      actorType: ActorType.SYSTEM,
      metadata: {
        apiSpecId: spec.id,
        apiKey: input.apiKey,
        environment,
        version: input.version,
        sourceFilename: input.sourceFilename,
      },
    });

    if (input.activate) {
      await activateApiSpecRevision(tx, input.workspaceId, spec.id);
    }

    return spec;
  });
}

export async function activateApiSpecRevision(
  db: Db,
  workspaceId: string,
  apiSpecId: string,
  actor: { actorType?: ActorType; actorId?: string } = {},
) {
  const run = async (tx: PrismaTransaction) => {
    const target = await tx.apiSpec.findFirst({
      where: { id: apiSpecId, workspaceId },
    });
    if (!target) {
      throw new Error("API spec revision not found in workspace");
    }

    await tx.$queryRaw`
      SELECT "id" FROM "api_specs"
      WHERE "workspace_id" = ${workspaceId}::uuid
        AND "api_key" = ${target.apiKey}
        AND "environment" = ${target.environment}
      FOR UPDATE
    `;

    const active = await tx.apiSpec.findFirst({
      where: { workspaceId, apiKey: target.apiKey, environment: target.environment, isActive: true },
    });
    const decision = decideActivation(
      active ? { id: active.id, revisionSequence: active.revisionSequence } : null,
      { id: target.id, revisionSequence: target.revisionSequence },
    );
    if (decision === "replay") return target;
    if (decision === "stale") {
      throw new SpecActivationError("An older deployment cannot replace a newer active revision.");
    }
    if (decision === "ambiguous") {
      throw new SpecActivationError("These revisions do not have a clear activation order.");
    }

    await tx.apiSpec.updateMany({
      where: {
        workspaceId,
        apiKey: target.apiKey,
        environment: target.environment,
        isActive: true,
        NOT: { id: apiSpecId },
      },
      data: { isActive: false },
    });

    const activated = await tx.apiSpec.update({
      where: { id: apiSpecId },
      data: { isActive: true, activatedAt: new Date() },
    });

    await appendAuditLog(tx, {
      workspaceId,
      eventType: AuditEventType.SPEC_ACTIVATED,
      actorType: actor.actorType ?? ActorType.SYSTEM,
      actorId: actor.actorId ?? null,
      metadata: {
        apiSpecId: activated.id,
        apiKey: activated.apiKey,
        environment: activated.environment,
        version: activated.version,
        revisionSequence: activated.revisionSequence,
      },
    });

    return activated;
  };

  if ("$transaction" in db) {
    return db.$transaction(run);
  }
  return run(db);
}

export async function getActiveApiSpec(
  db: Db,
  workspaceId: string,
  apiKey: string,
  environment = "default",
) {
  return db.apiSpec.findFirst({
    where: { workspaceId, apiKey, environment, isActive: true },
  });
}
