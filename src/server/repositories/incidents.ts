import {
  ActorType,
  AuditEventType,
  Prisma,
  type IncidentSource,
  type IncidentStatus,
  type PrismaClient,
  type ValidationStatus,
} from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import type { PrismaTransaction } from "@/lib/db";

type Db = PrismaClient | PrismaTransaction;

export type CreateIncidentInput = {
  workspaceId: string;
  apiKey: string;
  apiSpecId?: string | null;
  source: IncidentSource;
  sourceEventId: string;
  httpMethod: string;
  requestPath: string;
  statusCode: number;
  clientReference?: string | null;
  sanitizedRequestBody?: Prisma.InputJsonValue | null;
  status?: IncidentStatus;
  validationStatus?: ValidationStatus;
  validationEvidence?: Prisma.InputJsonValue | null;
  occurredAt: Date;
  receivedAt?: Date;
};

export async function createIncident(db: PrismaClient, input: CreateIncidentInput) {
  return db.$transaction(async (tx) => {
    const incident = await tx.incident.create({
      data: {
        workspaceId: input.workspaceId,
        apiKey: input.apiKey,
        apiSpecId: input.apiSpecId ?? null,
        source: input.source,
        sourceEventId: input.sourceEventId,
        httpMethod: input.httpMethod,
        requestPath: input.requestPath,
        statusCode: input.statusCode,
        clientReference: input.clientReference ?? null,
        sanitizedRequestBody:
          input.sanitizedRequestBody === undefined
            ? undefined
            : input.sanitizedRequestBody === null
              ? Prisma.JsonNull
              : input.sanitizedRequestBody,
        status: input.status ?? "RECEIVED",
        validationStatus: input.validationStatus ?? "NOT_RUN",
        validationEvidence:
          input.validationEvidence === undefined
            ? undefined
            : input.validationEvidence === null
              ? Prisma.JsonNull
              : input.validationEvidence,
        occurredAt: input.occurredAt,
        receivedAt: input.receivedAt ?? new Date(),
      },
    });

    await appendAuditLog(tx, {
      workspaceId: input.workspaceId,
      incidentId: incident.id,
      eventType: AuditEventType.INCIDENT_RECEIVED,
      actorType: ActorType.SYSTEM,
      metadata: {
        source: input.source,
        sourceEventId: input.sourceEventId,
        statusCode: input.statusCode,
        requestPath: input.requestPath,
      },
    });

    return incident;
  });
}

export async function getIncidentForWorkspace(
  db: Db,
  workspaceId: string,
  incidentId: string,
) {
  return db.incident.findFirst({
    where: { id: incidentId, workspaceId },
  });
}
