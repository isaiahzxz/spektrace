import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ActorType,
  AuditEventType,
  DeploymentEventStatus,
  Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import {
  findDeploymentAllowlistEntry,
  loadDeploymentImportAllowlistFromEnv,
} from "@/lib/deployment-context/allowlist";
import { DEPLOYMENT_CONTEXT_LIMITS } from "@/lib/deployment-context/config";

const SERVICE = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ENV = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const INTEGRATION = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const DEPLOYMENT_ID = z.string().trim().min(1).max(DEPLOYMENT_CONTEXT_LIMITS.maxSourceDeploymentIdLength);
const EVENT_ID = z.string().trim().min(1).max(DEPLOYMENT_CONTEXT_LIMITS.maxSourceEventIdLength);
const REPO = z
  .string()
  .trim()
  .min(1)
  .max(DEPLOYMENT_CONTEXT_LIMITS.maxRepositoryLength)
  .regex(/^[A-Za-z0-9._\-/]+$/)
  .optional();
const ARTIFACT = z.string().trim().min(1).max(DEPLOYMENT_CONTEXT_LIMITS.maxArtifactRefLength).optional();

export const deploymentEventImportSchema = z
  .object({
    integrationKey: INTEGRATION,
    sourceDeploymentId: DEPLOYMENT_ID,
    sourceEventId: EVENT_ID,
    apiKey: SERVICE,
    environment: ENV.optional(),
    status: z.enum(["started", "succeeded", "failed", "cancelled", "rolled_back"]),
    sourceReportedAt: z.string().datetime(),
    repository: REPO,
    commitSha: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,64}$/i)
      .transform((value) => value.toLowerCase())
      .optional(),
    artifactRef: ARTIFACT,
    apiSpecId: z.string().uuid().optional(),
    replacesSourceDeploymentId: DEPLOYMENT_ID.optional(),
  })
  .strict();

export type DeploymentEventImportInput = z.infer<typeof deploymentEventImportSchema>;

export class DeploymentImportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DeploymentImportError";
  }
}

function mapStatus(status: DeploymentEventImportInput["status"]): DeploymentEventStatus {
  switch (status) {
    case "started":
      return DeploymentEventStatus.STARTED;
    case "succeeded":
      return DeploymentEventStatus.SUCCEEDED;
    case "failed":
      return DeploymentEventStatus.FAILED;
    case "cancelled":
      return DeploymentEventStatus.CANCELLED;
    case "rolled_back":
      return DeploymentEventStatus.ROLLED_BACK;
    default:
      return DeploymentEventStatus.STARTED;
  }
}

export async function recordDeploymentEvent(
  prisma: PrismaClient,
  workspaceId: string,
  input: DeploymentEventImportInput,
) {
  const environment = input.environment ?? "default";
  const allowlist = loadDeploymentImportAllowlistFromEnv();
  const allowed = findDeploymentAllowlistEntry(allowlist, {
    integrationKey: input.integrationKey,
    apiKey: input.apiKey,
    environment,
  });
  if (!allowed) {
    throw new DeploymentImportError("Deployment import is not allowlisted for this integration.", "NOT_ALLOWLISTED");
  }

  if (input.apiSpecId) {
    const spec = await prisma.apiSpec.findFirst({
      where: { id: input.apiSpecId, workspaceId, apiKey: input.apiKey, environment },
    });
    if (!spec) {
      throw new DeploymentImportError("apiSpecId is not authorized for this service scope.", "API_SPEC_SCOPE_INVALID");
    }
  }

  const sourceReportedAt = new Date(input.sourceReportedAt);
  const status = mapStatus(input.status);

  const existingEvent = await prisma.deploymentStatusEvent.findFirst({
    where: {
      workspaceId,
      integrationKey: input.integrationKey,
      sourceEventId: input.sourceEventId,
    },
  });
  if (existingEvent) {
    const record = await prisma.deploymentRecord.findFirst({
      where: { id: existingEvent.deploymentRecordId, workspaceId },
    });
    return { event: existingEvent, record, created: false };
  }

  const result = await prisma.$transaction(async (tx) => {
    let record = await tx.deploymentRecord.findFirst({
      where: {
        workspaceId,
        integrationKey: input.integrationKey,
        sourceDeploymentId: input.sourceDeploymentId,
      },
    });

    if (!record) {
      record = await tx.deploymentRecord.create({
        data: {
          id: randomUUID(),
          workspaceId,
          integrationKey: input.integrationKey,
          sourceDeploymentId: input.sourceDeploymentId,
          apiKey: input.apiKey,
          environment,
          repository: input.repository ?? null,
          commitSha: input.commitSha ?? null,
          artifactRef: input.artifactRef ?? null,
          apiSpecId: input.apiSpecId ?? null,
          replacesSourceDeploymentId: input.replacesSourceDeploymentId ?? null,
        },
      });
    } else {
      if (record.apiKey !== input.apiKey || record.environment !== environment) {
        throw new DeploymentImportError("Deployment identity scope mismatch.", "DEPLOYMENT_SCOPE_MISMATCH");
      }
      const updates: Prisma.DeploymentRecordUpdateInput = {};
      if (!record.repository && input.repository) {
        updates.repository = input.repository;
      }
      if (!record.commitSha && input.commitSha) {
        updates.commitSha = input.commitSha;
      }
      if (!record.artifactRef && input.artifactRef) {
        updates.artifactRef = input.artifactRef;
      }
      if (!record.apiSpecId && input.apiSpecId) {
        updates.apiSpecId = input.apiSpecId;
      }
      if (!record.replacesSourceDeploymentId && input.replacesSourceDeploymentId) {
        updates.replacesSourceDeploymentId = input.replacesSourceDeploymentId;
      }
      if (Object.keys(updates).length > 0) {
        record = await tx.deploymentRecord.update({
          where: { id: record.id },
          data: updates,
        });
      }
    }

    const event = await tx.deploymentStatusEvent.create({
      data: {
        id: randomUUID(),
        workspaceId,
        deploymentRecordId: record.id,
        integrationKey: input.integrationKey,
        sourceEventId: input.sourceEventId,
        status,
        sourceReportedAt,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId,
        eventType: AuditEventType.DEPLOYMENT_EVENT_RECORDED,
        actorType: ActorType.SYSTEM,
        actorId: "deployment-import",
        metadata: {
          integrationKey: input.integrationKey,
          sourceDeploymentId: input.sourceDeploymentId,
          sourceEventId: input.sourceEventId,
          status: input.status,
          apiKey: input.apiKey,
          environment,
        } as Prisma.InputJsonValue,
      },
    });

    return { event, record, created: true };
  });

  return result;
}
