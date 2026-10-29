import {
  ActorType,
  AuditEventType,
  IncidentStatus,
  OutboxEventType,
  Prisma,
  ValidationStatus,
  type Incident,
  type PrismaClient,
} from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import {
  assertBodySizeLimit,
  normalizeHttpMethod,
  type IncidentSubmissionInput,
} from "@/lib/validation/incident-envelope";
import { buildUnsupportedEvidenceV1 } from "@/lib/validation/validation-evidence-v1";
import { redactSanitizedRequestBody } from "@/lib/redaction/sanitize-body";
import { outboxDedupeKeyForValidation } from "@/lib/investigation/outbox-keys";
import {
  scheduleInvestigationGroupingOutbox,
  validationReadyForGrouping,
} from "@/lib/investigation/schedule-outbox";
import { getActiveApiSpec } from "@/server/repositories/api-specs";
import { lockIngestionToken } from "@/server/services/ingestion-credentials";
import { selectHistoricalRevision } from "@/server/services/historical-revisions";
import { resolveIncidentSender } from "@/server/services/sender-identity";
import { senderReferenceSchema, senderUuid } from "@/lib/ingestion/sender-identity";

export class IncidentSubmissionConflictError extends Error {
  constructor(message = "Incident submission conflicts with an existing record") {
    super(message);
    this.name = "IncidentSubmissionConflictError";
  }
}

type StoredBody = Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined;

function normalizeBody(
  body: unknown | null | undefined,
): StoredBody {
  if (body === undefined) {
    return undefined;
  }
  if (body === null) {
    return Prisma.JsonNull;
  }
  return body as Prisma.InputJsonValue;
}

function bodiesEqual(
  a: unknown | null | undefined,
  b: unknown | null | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function conflictsWithExisting(
  existing: Incident,
  input: IncidentSubmissionInput,
  normalizedMethod: string,
  storedBody: unknown | null | undefined,
  credentialId: string | null,
): boolean {
  const storedClaim = existing.senderClaim ? senderReferenceSchema.safeParse(existing.senderClaim) : null;
  return (
    (existing.senderProvenance !== null && existing.collectorCredentialId !== credentialId) ||
    (existing.reportedClientRef ?? null) !== (input.reportedClientRef ?? null) ||
    (storedClaim?.success ? storedClaim.data.principalRef : null) !== (input.senderReference?.principalRef ?? null) ||
    (storedClaim?.success ? storedClaim.data.principalKind : null) !== (input.senderReference?.principalKind ?? null) ||
    (existing.revisionSelectionMode ?? "active_at_ingestion") !== (input.revisionSelectionMode ?? "active_at_ingestion") ||
    existing.apiKey !== input.apiKey ||
    existing.environment !== (input.environment ?? "default") ||
    (existing.applicationName ?? null) !== (input.client?.applicationName ?? null) ||
    (existing.applicationVersion ?? null) !== (input.client?.applicationVersion ?? null) ||
    (existing.platform ?? null) !== (input.client?.platform ?? null) ||
    (existing.sdkName ?? null) !== (input.client?.sdkName ?? null) ||
    (existing.sdkVersion ?? null) !== (input.client?.sdkVersion ?? null) ||
    existing.httpMethod !== normalizedMethod ||
    existing.requestPath !== input.requestPath ||
    existing.statusCode !== input.statusCode ||
    existing.source !== input.source ||
    !bodiesEqual(existing.sanitizedRequestBody, storedBody) ||
    existing.occurredAt.toISOString() !== new Date(input.occurredAt).toISOString() ||
    (existing.clientReference ?? null) !== (input.clientReference ?? null)
  );
}

export async function submitIncident(
  prisma: PrismaClient,
  workspaceId: string,
  input: IncidentSubmissionInput,
): Promise<{ incident: Incident; created: boolean }> {
  return prisma.$transaction((tx) => submitIncidentInTransaction(tx, workspaceId, input));
}

export async function submitIncidentWithIngestionToken(
  prisma: PrismaClient,
  token: string,
  input: IncidentSubmissionInput,
) {
  return prisma.$transaction(async (tx) => {
    const auth = await lockIngestionToken(tx, token);
    return submitIncidentInTransaction(tx, auth.workspaceId, input, auth.credentialId);
  });
}

async function submitIncidentInTransaction(
  prisma: Prisma.TransactionClient,
  workspaceId: string,
  input: IncidentSubmissionInput,
  credentialId: string | null = null,
): Promise<{ incident: Incident; created: boolean }> {
  input = { ...input,
    senderReference: input.senderReference ? senderReferenceSchema.parse(input.senderReference) : undefined,
    reportedClientRef: input.reportedClientRef ? senderUuid.parse(input.reportedClientRef) : undefined };
  assertBodySizeLimit(input.sanitizedRequestBody);
  const normalizedMethod = normalizeHttpMethod(input.httpMethod);

  const eventLockKey = JSON.stringify(["incident-submission", workspaceId, input.source, input.sourceEventId]);
  await prisma.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${eventLockKey}, 0))::text`;

  const redaction = redactSanitizedRequestBody(input.sanitizedRequestBody ?? null);
  const storedBody =
    input.sanitizedRequestBody === undefined
      ? undefined
      : (redaction.value as Prisma.InputJsonValue | null);

  const existing = await prisma.incident.findUnique({
    where: {
      workspaceId_source_sourceEventId: {
        workspaceId,
        source: input.source,
        sourceEventId: input.sourceEventId,
      },
    },
  });

  if (existing) {
    if (conflictsWithExisting(existing, input, normalizedMethod, storedBody ?? null, credentialId)) {
      throw new IncidentSubmissionConflictError();
    }
    return { incident: existing, created: false };
  }

  const environment = input.environment ?? "default";
  const sender = await resolveIncidentSender(prisma, workspaceId, credentialId, input.apiKey, environment,
    input.senderReference, input.reportedClientRef);
  const revisionSelectionMode = input.revisionSelectionMode ?? "active_at_ingestion";
  const historical = revisionSelectionMode === "historical"
    ? await selectHistoricalRevision(prisma, workspaceId, input.apiKey, environment, input.occurredAt) : null;
  const activeSpec = historical ? historical.spec : await getActiveApiSpec(prisma, workspaceId, input.apiKey, environment);
  const revisionSelection: Prisma.InputJsonObject = historical?.provenance ?? {
    version: "active-at-ingestion@1", mode: revisionSelectionMode,
    reason: activeSpec ? "ACTIVE_AT_INGESTION" : "ACTIVE_SPEC_NOT_FOUND", runtimeVerified: false,
    selectedAt: new Date().toISOString(), ...(activeSpec ? { apiSpecId: activeSpec.id, sourceSha256: activeSpec.sourceSha256 } : {}),
  };

  let status: IncidentStatus = IncidentStatus.RECEIVED;
  let validationStatus: ValidationStatus = ValidationStatus.NOT_RUN;
  let validationEvidence: Prisma.InputJsonValue | undefined;
  let apiSpecId: string | null = activeSpec?.id ?? null;

  if (redaction.validationBlocked || redaction.incomplete) {
    status = IncidentStatus.NEEDS_REVIEW;
    validationStatus = ValidationStatus.UNSUPPORTED;
    validationEvidence = buildUnsupportedEvidenceV1({
      reasonCode: "REDACTION_BLOCKED_VALIDATION",
      reasonMessage:
        "Sensitive fields were redacted from the submitted body, so schema validation cannot be treated as conclusive.",
      apiSpecId: activeSpec?.id,
      sourceSha256: activeSpec?.sourceSha256,
      redactedPaths: redaction.redactedPaths,
    });
  } else if (!activeSpec) {
    status = IncidentStatus.NEEDS_REVIEW;
    validationStatus = ValidationStatus.UNSUPPORTED;
    apiSpecId = null;
    validationEvidence = buildUnsupportedEvidenceV1({
      reasonCode: historical?.reason ?? "ACTIVE_SPEC_NOT_FOUND",
      reasonMessage: historical ? "Historical contract selection is unknown. No current-revision fallback was used." : `No active API specification revision exists for apiKey "${input.apiKey}".`,
    });
  }

  const tx = prisma;
    const created = await tx.incident.create({
      data: {
        workspaceId,
        apiKey: input.apiKey,
        environment,
        collectorCredentialId: credentialId,
        senderId: sender.senderId,
        senderBindingId: sender.senderBindingId,
        senderClaim: input.senderReference ?? undefined,
        reportedClientRef: input.reportedClientRef,
        senderProvenance: sender.provenance,
        applicationName: input.client?.applicationName ?? null,
        applicationVersion: input.client?.applicationVersion ?? null,
        platform: input.client?.platform ?? null,
        sdkName: input.client?.sdkName ?? null,
        sdkVersion: input.client?.sdkVersion ?? null,
        apiSpecId,
        revisionSelectionMode,
        revisionSelection,
        source: input.source,
        sourceEventId: input.sourceEventId,
        httpMethod: normalizedMethod,
        requestPath: input.requestPath,
        statusCode: input.statusCode,
        clientReference: input.clientReference ?? null,
        sanitizedRequestBody: normalizeBody(storedBody),
        status,
        validationStatus,
        validationEvidence: validationEvidence ?? undefined,
        occurredAt: new Date(input.occurredAt),
      },
    });

    await appendAuditLog(tx, {
      workspaceId,
      incidentId: created.id,
      eventType: AuditEventType.INCIDENT_RECEIVED,
      actorType: ActorType.SYSTEM,
      metadata: {
        source: input.source,
        sourceEventId: input.sourceEventId,
        apiKey: input.apiKey,
        statusCode: input.statusCode,
        requestPath: input.requestPath,
        redactedPathCount: redaction.redactedPaths.length,
      },
    });

    await tx.outboxEvent.create({
      data: {
        workspaceId,
        incidentId: created.id,
        dedupeKey: outboxDedupeKeyForValidation(created.id),
        eventType: OutboxEventType.INCIDENT_VALIDATION_REQUESTED,
      },
    });

    if (validationReadyForGrouping(validationStatus)) {
      await scheduleInvestigationGroupingOutbox(tx, workspaceId, created.id);
    }

  return { incident: created, created: true };
}
