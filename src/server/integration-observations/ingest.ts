import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { z } from "zod";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import {
  baselineScope,
  canonical,
  coverageSchema,
  digest,
  observationSchema,
  outcomeSchema,
} from "@/lib/integration-observations/contract";
import {
  authenticateIngestionToken,
  lockIngestionToken,
} from "@/server/services/ingestion-credentials";

export class IntegrationConflictError extends Error {
  constructor() {
    super("Integration event conflicts with retained evidence");
  }
}
export class IntegrationScopeError extends Error {
  constructor() {
    super("Integration reference unavailable in scope");
  }
}
export async function lockIntegrationKeys(
  tx: Prisma.TransactionClient,
  keys: string[],
) {
  for (const key of [...new Set(keys)].sort())
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`;
}
const inputSchema = z.discriminatedUnion("kind", [
  observationSchema,
  coverageSchema,
]);
export async function ingestIntegrationEvent(
  db: PrismaClient,
  token: string,
  raw: unknown,
) {
  const input = inputSchema.parse(raw),
    { sourceEventId, ...content } = input,
    payloadDigest = digest(content);
  return db.$transaction(async (tx) => {
    const auth = await lockIngestionToken(tx, token),
      workspaceId = auth.workspaceId;
    const logical =
      input.kind === "observation"
        ? [
            "call",
            input.integration.key,
            input.integration.environment,
            input.callId,
            input.attempt,
          ]
        : ["coverage", input.instanceId, input.sequence];
    await lockIntegrationKeys(tx, [
      canonical([workspaceId, input.kind, sourceEventId]),
      canonical([workspaceId, ...logical]),
    ]);
    await authenticateIngestionToken(tx, token);
    if (input.kind === "coverage") {
      const existing = await tx.integrationCoverage.findMany({
        where: {
          workspaceId,
          OR: [
            { sourceEventId },
            { instanceId: input.instanceId, sequence: input.sequence },
          ],
        },
        take: 2,
      });
      if (existing.length) {
        if (
          existing.length !== 1 ||
          existing[0].payloadDigest !== payloadDigest
        )
          throw new IntegrationConflictError();
        return { id: existing[0].id, created: false };
      }
      const row = await tx.integrationCoverage.create({
        data: {
          workspaceId,
          collectorCredentialId: auth.credentialId,
          sourceEventId,
          instanceId: input.instanceId,
          sequence: input.sequence,
          integrationKey: input.integration.key,
          providerKey: input.integration.provider,
          environment: input.integration.environment,
          envelope: input,
          payloadDigest,
        },
      });
      return { id: row.id, created: true };
    }
    const existing = await tx.integrationObservation.findMany({
      where: {
        workspaceId,
        OR: [
          { sourceEventId },
          {
            integrationKey: input.integration.key,
            environment: input.integration.environment,
            callId: input.callId,
            attempt: input.attempt,
          },
        ],
      },
      take: 2,
    });
    if (existing.length) {
      if (existing.length !== 1 || existing[0].payloadDigest !== payloadDigest)
        throw new IntegrationConflictError();
      return { id: existing[0].id, created: false };
    }
    if (input.requestIncidentId) {
      const related = await tx.incident.findFirst({
        where: {
          id: input.requestIncidentId,
          workspaceId,
          apiKey: input.integration.key,
          environment: input.integration.environment,
          httpMethod: input.operation.method,
          requestPath: input.operation.path,
        },
        select: { id: true },
      });
      if (!related) throw new IntegrationScopeError();
    }
    const scopeKey = baselineScope(
      input,
      input.result.kind === "HTTP" ? input.result.statusCode : 0,
      input.capture.pointers,
    );
    await lockIntegrationKeys(tx, [
      canonical(["baseline", workspaceId, scopeKey]),
    ]);
    await authenticateIngestionToken(tx, token);
    const baseline =
      input.result.kind === "HTTP"
        ? await tx.integrationResponseBaseline.findFirst({
            where: { workspaceId, scopeKey, active: true },
            select: { id: true },
          })
        : null;
    const row = await tx.integrationObservation.create({
      data: {
        workspaceId,
        collectorCredentialId: auth.credentialId,
        sourceEventId,
        callId: input.callId,
        attempt: input.attempt,
        integrationKey: input.integration.key,
        providerKey: input.integration.provider,
        environment: input.integration.environment,
        httpMethod: input.operation.method,
        operationPath: input.operation.path,
        correlationKind: input.correlation?.kind,
        correlationId: input.correlation?.id,
        correlationAttempt: input.correlation?.attempt,
        resultKind: input.result.kind,
        statusCode:
          input.result.kind === "HTTP" ? input.result.statusCode : null,
        durationMs: input.durationMs,
        scopeKey,
        baselineId: baseline?.id,
        requestIncidentId: input.requestIncidentId,
        envelope: input,
        payloadDigest,
        occurredAt: new Date(input.occurredAt),
      },
    });
    await tx.outboxEvent.create({
      data: {
        workspaceId,
        integrationObservationId: row.id,
        eventType: "INTEGRATION_OBSERVATION_REQUESTED",
        dedupeKey: `integration-observation:${row.id}`,
      },
    });
    await appendAuditLog(tx, {
      workspaceId,
      eventType: "INTEGRATION_OBSERVATION_RECEIVED",
      actorType: "SYSTEM",
      metadata: { observationId: row.id, baselineId: baseline?.id ?? null },
    });
    return { id: row.id, created: true };
  });
}
export async function ingestWorkflowOutcome(
  db: PrismaClient,
  token: string,
  raw: unknown,
) {
  const input = outcomeSchema.parse(raw),
    { sourceEventId, ...content } = input,
    payloadDigest = digest(content);
  return db.$transaction(async (tx) => {
    const auth = await lockIngestionToken(tx, token),
      workspaceId = auth.workspaceId;
    await lockIntegrationKeys(tx, [
      canonical([workspaceId, "outcome", sourceEventId]),
      canonical([
        workspaceId,
        "outcome",
        input.integration.key,
        input.integration.environment,
        input.correlation,
      ]),
    ]);
    await authenticateIngestionToken(tx, token);
    const existing = await tx.integrationWorkflowOutcome.findMany({
      where: {
        workspaceId,
        OR: [
          { sourceEventId },
          {
            integrationKey: input.integration.key,
            environment: input.integration.environment,
            correlationKind: input.correlation.kind,
            correlationId: input.correlation.id,
            correlationAttempt: input.correlation.attempt,
          },
        ],
      },
      take: 2,
    });
    if (existing.length) {
      if (existing.length !== 1 || existing[0].payloadDigest !== payloadDigest)
        throw new IntegrationConflictError();
      return { id: existing[0].id, created: false };
    }
    const row = await tx.integrationWorkflowOutcome.create({
      data: {
        workspaceId,
        collectorCredentialId: auth.credentialId,
        sourceEventId,
        integrationKey: input.integration.key,
        providerKey: input.integration.provider,
        environment: input.integration.environment,
        correlationKind: input.correlation.kind,
        correlationId: input.correlation.id,
        correlationAttempt: input.correlation.attempt,
        outcome: input.outcome,
        occurredAt: new Date(input.occurredAt),
        envelope: input,
        payloadDigest,
      },
    });
    await tx.outboxEvent.create({
      data: {
        workspaceId,
        integrationOutcomeId: row.id,
        eventType: "INTEGRATION_OUTCOME_REQUESTED",
        dedupeKey: `integration-outcome:${row.id}`,
      },
    });
    await appendAuditLog(tx, {
      workspaceId,
      eventType: "INTEGRATION_OUTCOME_RECEIVED",
      actorType: "SYSTEM",
      metadata: { outcomeId: row.id, outcome: input.outcome },
    });
    return { id: row.id, created: true };
  });
}
