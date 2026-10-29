import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IncidentSource,
  OutboxDispatchStatus,
  ValidationStatus,
} from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { getRedisKeyPrefix } from "@/lib/internal-config";
import { resetIncidentQueueForTests } from "@/lib/queue/incident-queue";
import { dispatchOutboxBatch } from "@/server/outbox/dispatcher";
import { activateApiSpecRevision, registerApiSpec } from "@/server/repositories/api-specs";
import {
  IncidentSubmissionConflictError,
  submitIncident,
} from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { resetDatabase } from "./helpers/reset-database";

const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());

process.env.SPEKTRACE_REDIS_PREFIX = `${getRedisKeyPrefix()}-test-${randomUUID().slice(0, 8)}`;

describe("incident processing flow", () => {
  beforeEach(async () => {
    await resetIncidentQueueForTests();
    await resetDatabase(prisma);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await resetIncidentQueueForTests();
    await prisma.$disconnect();
  });

  async function seedWorkspaceWithActiveSpec(workspaceId: string) {
    const spec = await registerApiSpec(prisma, {
      workspaceId,
      apiKey: "payments-api",
      name: "Payments",
      version: "1.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "demo.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: "sha-demo",
      parsedDocument: {
        openapi: "3.1.0",
        paths: {
          "/payments": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["amount"],
                      properties: { amount: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    await activateApiSpecRevision(prisma, workspaceId, spec.id);
    return spec;
  }

  it("submits, dispatches, and validates a fractional amount mismatch", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Flow", slug: `flow-${randomUUID()}` },
    });
    const spec = await seedWorkspaceWithActiveSpec(workspace.id);
    const eventId = `flow-${randomUUID()}`;

    const submitted = await submitIncident(prisma, workspace.id, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: eventId,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    });

    expect(submitted.created).toBe(true);
    expect(submitted.incident.apiSpecId).toBe(spec.id);

    await dispatchOutboxBatch(prisma);
    const processed = await processIncidentValidation(
      prisma,
      workspace.id,
      submitted.incident.id,
    );
    expect(processed.status).toBe("processed");

    const updated = await prisma.incident.findUnique({
      where: { id: submitted.incident.id },
    });
    expect(updated?.validationStatus).toBe(ValidationStatus.MISMATCH);
    expect(updated?.status).toBe("NEEDS_REVIEW");
    const evidence = updated?.validationEvidence as {
      plainEnglishSummary?: string;
    } | null;
    expect(evidence?.plainEnglishSummary).toContain("whole number");
  });

  it("returns existing incident for identical retries and rejects conflicts", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Retry", slug: `retry-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(workspace.id);

    const payload = {
      source: IncidentSource.WEBHOOK,
      sourceEventId: "retry-evt",
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    };

    const first = await submitIncident(prisma, workspace.id, payload);
    const second = await submitIncident(prisma, workspace.id, payload);
    expect(second.created).toBe(false);
    expect(second.incident.id).toBe(first.incident.id);

    const audits = await prisma.auditLog.count({
      where: { incidentId: first.incident.id, eventType: "INCIDENT_RECEIVED" },
    });
    expect(audits).toBe(1);

    await expect(
      submitIncident(prisma, workspace.id, {
        ...payload,
        statusCode: 401,
      }),
    ).rejects.toBeInstanceOf(IncidentSubmissionConflictError);
  });

  it("handles duplicate job delivery idempotently", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Dup", slug: `dup-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(workspace.id);

    const submitted = await submitIncident(prisma, workspace.id, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: `dup-${randomUUID()}`,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    });

    await dispatchOutboxBatch(prisma);
    await processIncidentValidation(prisma, workspace.id, submitted.incident.id);
    await processIncidentValidation(prisma, workspace.id, submitted.incident.id);

    const completedAudits = await prisma.auditLog.count({
      where: {
        incidentId: submitted.incident.id,
        eventType: "VALIDATION_COMPLETED",
      },
    });
    expect(completedAudits).toBe(1);
  });

  it("recovers outbox publication after enqueue succeeds before mark published", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Crash", slug: `crash-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(workspace.id);

    const submitted = await submitIncident(prisma, workspace.id, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: `crash-${randomUUID()}`,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    });

    const outbox = await prisma.outboxEvent.findFirst({
      where: { incidentId: submitted.incident.id },
    });
    expect(outbox).not.toBeNull();

    await prisma.outboxEvent.update({
      where: { id: outbox!.id },
      data: {
        dispatchStatus: OutboxDispatchStatus.CLAIMED,
        claimExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    await dispatchOutboxBatch(prisma);
    const published = await prisma.outboxEvent.findUnique({ where: { id: outbox!.id } });
    expect(published?.dispatchStatus).toBe(OutboxDispatchStatus.PUBLISHED);
  });

  it("marks outbox pending again when redis publication fails", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "RedisFail", slug: `redis-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(workspace.id);

    const submitted = await submitIncident(prisma, workspace.id, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: `redis-${randomUUID()}`,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    });

    await dispatchOutboxBatch(prisma, {
      publishJob: async () => {
        throw new Error("redis unavailable");
      },
    });
    const outbox = await prisma.outboxEvent.findFirst({
      where: { incidentId: submitted.incident.id },
    });
    expect(outbox?.dispatchStatus).toBe(OutboxDispatchStatus.PENDING);
    expect(outbox?.lastError).toContain("redis unavailable");
  });
});
