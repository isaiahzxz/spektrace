import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  EvidencePreparationRunStatus,
  IncidentSource,
  IncidentStatus,
  OutboxEventType,
  ValidationStatus,
} from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { getRedisKeyPrefix } from "@/lib/internal-config";
import { INVESTIGATION_PREPARATION_LIMITS } from "@/lib/investigation/config";
import { resetIncidentQueueForTests } from "@/lib/queue/incident-queue";
import { dispatchOutboxBatch } from "@/server/outbox/dispatcher";
import { activateApiSpecRevision, registerApiSpec } from "@/server/repositories/api-specs";
import { assignIncidentToInvestigationGroup } from "@/server/services/assign-incident-investigation-group";
import { processEvidencePreparation } from "@/server/services/process-evidence-preparation";
import { submitIncident, submitIncidentWithIngestionToken } from "@/server/services/incident-submission";
import { importSenderBinding } from "@/server/services/sender-identity";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { resetDatabase } from "./helpers/reset-database";

const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());

process.env.SPEKTRACE_REDIS_PREFIX = `${getRedisKeyPrefix()}-test-${randomUUID().slice(0, 8)}`;
process.env.SPEKTRACE_EVIDENCE_PREPARATION_ENABLED = "true";

describe("investigation grouping and evidence preparation", () => {
  const collectors = new Map<string, { token: string; principalRef: string }>();
  beforeEach(async () => {
    collectors.clear();
    await resetIncidentQueueForTests();
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetIncidentQueueForTests();
    await prisma.$disconnect();
  });

  async function seedWorkspaceWithActiveSpec(workspaceId: string) {
    const document = {
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
      };
    const sourceText = JSON.stringify(document);
    const spec = await registerApiSpec(prisma, { workspaceId, apiKey: "payments-api", name: "Payments", version: "1.0.0",
      openApiVersion: "3.1.0", sourceFilename: "synthetic.json", sourceText,
      sourceSha256: createHash("sha256").update(sourceText).digest("hex"), parsedDocument: document });
    await activateApiSpecRevision(prisma, workspaceId, spec.id);
    return spec;
  }

  async function submitForSender(workspaceId: string, input: Parameters<typeof submitIncident>[2]) {
    let collector = collectors.get(workspaceId);
    if (!collector) {
      const issued = await issueIngestionCredential(prisma, workspaceId, "Grouping fixture collector");
      const principalRef = randomUUID();
      await importSenderBinding(prisma, workspaceId, { ingestionCredentialId: issued.credential.id, apiKey: "payments-api", environment: "default",
        principalKind: "api_key_id", principalRef, senderKey: randomUUID(), displayName: "Synthetic grouping sender" });
      collector = { token: issued.token, principalRef }; collectors.set(workspaceId, collector);
    }
    return submitIncidentWithIngestionToken(prisma, collector.token, { ...input,
      senderReference: { principalKind: "api_key_id", principalRef: collector.principalRef } });
  }

  async function ingestMismatch(workspaceId: string, sourceEventId: string) {
    const submitted = await submitForSender(workspaceId, {
      source: IncidentSource.WEBHOOK,
      sourceEventId,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    });
    await processIncidentValidation(prisma, workspaceId, submitted.incident.id);
    return submitted.incident.id;
  }

  it("groups equivalent incidents and reaches evidence ready without AI investigation", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Group", slug: `group-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(workspace.id);

    const firstId = await ingestMismatch(workspace.id, `evt-${randomUUID()}`);
    const secondId = await ingestMismatch(workspace.id, `evt-${randomUUID()}`);

    const firstAssign = await assignIncidentToInvestigationGroup(
      prisma,
      workspace.id,
      firstId,
    );
    const secondAssign = await assignIncidentToInvestigationGroup(
      prisma,
      workspace.id,
      secondId,
    );

    expect(firstAssign).toMatchObject({ status: "assigned" });
    expect(secondAssign).toMatchObject({ status: "assigned" });
    if (firstAssign.status !== "assigned" || secondAssign.status !== "assigned") {
      throw new Error("expected assigned groups");
    }
    expect(firstAssign.investigationGroupId).toBe(secondAssign.investigationGroupId);

    const prepared = await processEvidencePreparation(
      prisma,
      workspace.id,
      firstAssign.investigationGroupId,
    );
    expect(prepared).toMatchObject({
      status: "processed",
      runStatus: EvidencePreparationRunStatus.EVIDENCE_READY,
    });

    const run = await prisma.evidencePreparationRun.findFirst({
      where: { investigationGroupId: firstAssign.investigationGroupId },
    });
    const summary = run?.protectedSummary as {
      aiInvestigationPerformed?: boolean;
      includedIncidentCount?: number;
    };
    expect(summary?.aiInvestigationPerformed).toBe(false);
    expect(summary?.includedIncidentCount).toBe(2);

    const incidents = await prisma.incident.findMany({
      where: { id: { in: [firstId, secondId] } },
    });
    expect(incidents.every((row) => row.status === IncidentStatus.NEEDS_REVIEW)).toBe(
      true,
    );
    expect(incidents.every((row) => row.validationStatus === ValidationStatus.MISMATCH)).toBe(
      true,
    );
  });

  it("keeps different workspaces and finding signatures in separate groups", async () => {
    const w1 = await prisma.workspace.create({
      data: { name: "W1", slug: `w1-${randomUUID()}` },
    });
    const w2 = await prisma.workspace.create({
      data: { name: "W2", slug: `w2-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(w1.id);
    await seedWorkspaceWithActiveSpec(w2.id);

    const w1Incident = await ingestMismatch(w1.id, `w1-${randomUUID()}`);
    const w2Incident = await ingestMismatch(w2.id, `w2-${randomUUID()}`);

    const w1Assign = await assignIncidentToInvestigationGroup(prisma, w1.id, w1Incident);
    const w2Assign = await assignIncidentToInvestigationGroup(prisma, w2.id, w2Incident);
    if (w1Assign.status !== "assigned" || w2Assign.status !== "assigned") {
      throw new Error("expected assigned groups");
    }
    expect(w1Assign.investigationGroupId).not.toBe(w2Assign.investigationGroupId);

    const passed = await submitForSender(w1.id, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: `pass-${randomUUID()}`,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12 },
    });
    await processIncidentValidation(prisma, w1.id, passed.incident.id);
    const passAssign = await assignIncidentToInvestigationGroup(
      prisma,
      w1.id,
      passed.incident.id,
    );
    if (passAssign.status !== "assigned") {
      throw new Error("expected assigned pass group");
    }
    expect(passAssign.investigationGroupId).not.toBe(w1Assign.investigationGroupId);
  });

  it("routes unsupported ingestion incidents into preparation", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Unsupported", slug: `unsupported-${randomUUID()}` },
    });

    const submitted = await submitIncident(prisma, workspace.id, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: `unsupported-${randomUUID()}`,
      apiKey: "missing-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 1 },
    });

    expect(submitted.incident.validationStatus).toBe(ValidationStatus.UNSUPPORTED);

    const groupingOutbox = await prisma.outboxEvent.findFirst({
      where: {
        incidentId: submitted.incident.id,
        eventType: OutboxEventType.INCIDENT_INVESTIGATION_GROUPING_REQUESTED,
      },
    });
    expect(groupingOutbox).not.toBeNull();

    await processIncidentValidation(prisma, workspace.id, submitted.incident.id);
    const assigned = await assignIncidentToInvestigationGroup(
      prisma,
      workspace.id,
      submitted.incident.id,
    );
    expect(assigned).toMatchObject({ status: "assigned" });
    if (assigned.status !== "assigned") {
      throw new Error("expected assigned unsupported incident");
    }

    const prepared = await processEvidencePreparation(
      prisma,
      workspace.id,
      assigned.investigationGroupId,
    );
    expect(prepared).toMatchObject({
      runStatus: EvidencePreparationRunStatus.EVIDENCE_READY,
    });
  });

  it("deduplicates grouping and preparation deliveries", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Dedupe", slug: `dedupe-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(workspace.id);
    const incidentId = await ingestMismatch(workspace.id, `dedupe-${randomUUID()}`);

    await assignIncidentToInvestigationGroup(prisma, workspace.id, incidentId);
    await assignIncidentToInvestigationGroup(prisma, workspace.id, incidentId);

    const memberships = await prisma.investigationGroupMembership.count({
      where: { incidentId },
    });
    expect(memberships).toBe(1);

    const group = await prisma.investigationGroupMembership.findFirst({
      where: { incidentId },
    });

    await processEvidencePreparation(prisma, workspace.id, group!.investigationGroupId);
    await processEvidencePreparation(prisma, workspace.id, group!.investigationGroupId);

    const runs = await prisma.evidencePreparationRun.count({
      where: { investigationGroupId: group!.investigationGroupId },
    });
    expect(runs).toBe(1);
  });

  it("schedules follow-up preparation when membership changes during a run", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "FollowUp", slug: `follow-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(workspace.id);
    const firstId = await ingestMismatch(workspace.id, `f1-${randomUUID()}`);
    const firstAssign = await assignIncidentToInvestigationGroup(
      prisma,
      workspace.id,
      firstId,
    );
    if (firstAssign.status !== "assigned") {
      throw new Error("expected assigned first incident");
    }
    const groupId = firstAssign.investigationGroupId;

    const secondId = await ingestMismatch(workspace.id, `f2-${randomUUID()}`);
    await assignIncidentToInvestigationGroup(prisma, workspace.id, secondId);

    const prepared = await processEvidencePreparation(prisma, workspace.id, groupId);
    expect(prepared).toMatchObject({
      runStatus: EvidencePreparationRunStatus.EVIDENCE_READY,
    });

    const group = await prisma.investigationGroup.findUnique({ where: { id: groupId } });
    expect(group?.preparedMembershipVersion).toBe(group?.membershipVersion);

    const runs = await prisma.evidencePreparationRun.findMany({
      where: { investigationGroupId: groupId },
      orderBy: { runSequence: "asc" },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.membershipVersion).toBe(group?.membershipVersion);
  });

  it("records omission counts when group membership exceeds preparation limits", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Limit", slug: `limit-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(workspace.id);

    let groupId: string | null = null;
    for (let i = 0; i < INVESTIGATION_PREPARATION_LIMITS.maxIncidentsPerRun + 3; i += 1) {
      const incidentId = await ingestMismatch(workspace.id, `limit-${i}-${randomUUID()}`);
      const assigned = await assignIncidentToInvestigationGroup(
        prisma,
        workspace.id,
        incidentId,
      );
      if (assigned.status !== "assigned") {
        throw new Error("expected assigned limit incident");
      }
      groupId = assigned.investigationGroupId;
    }
    if (!groupId) {
      throw new Error("expected group id");
    }

    const prepared = await processEvidencePreparation(prisma, workspace.id, groupId);
    expect(prepared).toMatchObject({
      runStatus: EvidencePreparationRunStatus.EVIDENCE_READY,
    });

    const run = await prisma.evidencePreparationRun.findFirst({
      where: { investigationGroupId: groupId },
    });
    expect(run?.includedIncidentCount).toBe(
      INVESTIGATION_PREPARATION_LIMITS.maxIncidentsPerRun,
    );
    expect(run?.omittedIncidentCount).toBe(3);
  });

  it("does not merge unrelated unresolved operations that share the same unsupported reason", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Unresolved", slug: `unresolved-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(workspace.id);

    async function ingestUnknownPath(path: string, sourceEventId: string) {
      const submitted = await submitForSender(workspace.id, {
        source: IncidentSource.WEBHOOK,
        sourceEventId,
        apiKey: "payments-api",
        httpMethod: "POST",
        requestPath: path,
        statusCode: 400,
        occurredAt: new Date().toISOString(),
        sanitizedRequestBody: { amount: 1 },
      });
      await processIncidentValidation(prisma, workspace.id, submitted.incident.id);
      return submitted.incident.id;
    }

    const firstId = await ingestUnknownPath("/unknown-a", `u-a-${randomUUID()}`);
    const secondId = await ingestUnknownPath("/unknown-b", `u-b-${randomUUID()}`);

    const firstAssign = await assignIncidentToInvestigationGroup(prisma, workspace.id, firstId);
    const secondAssign = await assignIncidentToInvestigationGroup(prisma, workspace.id, secondId);
    if (firstAssign.status !== "assigned" || secondAssign.status !== "assigned") {
      throw new Error("expected assigned unresolved incidents");
    }
    expect(firstAssign.investigationGroupId).not.toBe(secondAssign.investigationGroupId);
  });

  it("dispatches grouping jobs from the outbox after validation", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Outbox", slug: `outbox-${randomUUID()}` },
    });
    await seedWorkspaceWithActiveSpec(workspace.id);
    const incidentId = await ingestMismatch(workspace.id, `outbox-${randomUUID()}`);

    const published: string[] = [];
    await dispatchOutboxBatch(prisma, {
      publishJob: async (payload) => {
        published.push(payload.task);
      },
      batchSize: 10,
    });

    expect(published).toContain("assign-group");
    expect(published).toContain("validate");

    const before = await prisma.incident.findUnique({ where: { id: incidentId } });
    await assignIncidentToInvestigationGroup(prisma, workspace.id, incidentId);
    const after = await prisma.incident.findUnique({ where: { id: incidentId } });
    expect(before).toMatchObject({
      status: after?.status,
      validationStatus: after?.validationStatus,
      approvedAt: after?.approvedAt,
    });
  });
});
