import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  EvidencePreparationRunStatus,
  IncidentSource,
  InvestigationInferenceRunStatus,
  ValidationStatus,
} from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { getRedisKeyPrefix } from "@/lib/internal-config";
import { resetIncidentQueueForTests } from "@/lib/queue/incident-queue";
import { activateApiSpecRevision, registerApiSpec } from "@/server/repositories/api-specs";
import { assignIncidentToInvestigationGroup } from "@/server/services/assign-incident-investigation-group";
import { processEvidencePreparation } from "@/server/services/process-evidence-preparation";
import { processInvestigationInference } from "@/server/services/process-investigation-inference";
import { submitIncident } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { resetDatabase } from "./helpers/reset-database";

const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());

process.env.SPEKTRACE_REDIS_PREFIX = `${getRedisKeyPrefix()}-test-${randomUUID().slice(0, 8)}`;
process.env.SPEKTRACE_EVIDENCE_PREPARATION_ENABLED = "true";
process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = "true";
process.env.SPEKTRACE_AI_INFERENCE_ADAPTER = "test";

describe("investigation inference stage 3", () => {
  beforeEach(async () => {
    await resetIncidentQueueForTests();
    await resetDatabase(prisma);
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

  async function ingestMismatch(workspaceId: string, sourceEventId: string) {
    const submitted = await submitIncident(prisma, workspaceId, {
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

  it("runs structured inference after evidence preparation without mutating incidents", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Infer", slug: `infer-${randomUUID()}` },
    });
    process.env.SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID = workspace.id;
    await seedWorkspaceWithActiveSpec(workspace.id);

    const firstId = await ingestMismatch(workspace.id, `evt-${randomUUID()}`);
    const secondId = await ingestMismatch(workspace.id, `evt-${randomUUID()}`);
    const firstAssign = await assignIncidentToInvestigationGroup(prisma, workspace.id, firstId);
    await assignIncidentToInvestigationGroup(prisma, workspace.id, secondId);
    if (firstAssign.status !== "assigned") {
      throw new Error("expected assigned group");
    }

    const prepared = await processEvidencePreparation(
      prisma,
      workspace.id,
      firstAssign.investigationGroupId,
    );
    expect(prepared).toMatchObject({
      status: "processed",
      runStatus: EvidencePreparationRunStatus.EVIDENCE_READY,
    });

    const prepRun = await prisma.evidencePreparationRun.findFirst({
      where: { investigationGroupId: firstAssign.investigationGroupId },
    });
    if (!prepRun) {
      throw new Error("missing prep run");
    }

    const inferred = await processInvestigationInference(prisma, workspace.id, prepRun.id);
    expect(inferred).toMatchObject({
      status: "processed",
      runStatus: InvestigationInferenceRunStatus.SUCCEEDED,
    });

    const run = await prisma.investigationInferenceRun.findFirst({
      where: { evidencePreparationRunId: prepRun.id },
    });
    expect(run?.validatedOutput).toBeTruthy();
    expect(run?.evidenceInputHash).not.toBe("pending");

    const incidents = await prisma.incident.findMany({
      where: { id: { in: [firstId, secondId] } },
    });
    expect(incidents.every((row) => row.validationStatus === ValidationStatus.MISMATCH)).toBe(
      true,
    );
    expect(incidents.every((row) => row.approvedAt === null)).toBe(true);
  });

  it("skips inference when AI is disabled", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Disabled", slug: `disabled-${randomUUID()}` },
    });
    process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = "false";
    await seedWorkspaceWithActiveSpec(workspace.id);
    const incidentId = await ingestMismatch(workspace.id, `evt-${randomUUID()}`);
    const assigned = await assignIncidentToInvestigationGroup(prisma, workspace.id, incidentId);
    if (assigned.status !== "assigned") {
      throw new Error("expected assigned");
    }
    await processEvidencePreparation(prisma, workspace.id, assigned.investigationGroupId);
    const prepRun = await prisma.evidencePreparationRun.findFirst({
      where: { investigationGroupId: assigned.investigationGroupId },
    });
    const result = await processInvestigationInference(prisma, workspace.id, prepRun!.id);
    expect(result).toMatchObject({ status: "skipped", reason: "ai_disabled" });
    process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = "true";
  });

  it("rebuilds evidence from the preparation manifest snapshot only", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Snapshot", slug: `snapshot-${randomUUID()}` },
    });
    process.env.SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID = workspace.id;
    await seedWorkspaceWithActiveSpec(workspace.id);

    const firstId = await ingestMismatch(workspace.id, `evt-${randomUUID()}`);
    const assigned = await assignIncidentToInvestigationGroup(prisma, workspace.id, firstId);
    if (assigned.status !== "assigned") {
      throw new Error("expected assigned");
    }
    await processEvidencePreparation(prisma, workspace.id, assigned.investigationGroupId);
    const firstPrep = await prisma.evidencePreparationRun.findFirst({
      where: { investigationGroupId: assigned.investigationGroupId },
      orderBy: { runSequence: "asc" },
    });
    if (!firstPrep) {
      throw new Error("missing first prep");
    }

    const secondId = await ingestMismatch(workspace.id, `evt-${randomUUID()}`);
    await assignIncidentToInvestigationGroup(prisma, workspace.id, secondId);

    const inferred = await processInvestigationInference(prisma, workspace.id, firstPrep.id);
    expect(inferred).toMatchObject({
      status: "processed",
      runStatus: InvestigationInferenceRunStatus.SUCCEEDED,
    });
    const run = await prisma.investigationInferenceRun.findFirst({
      where: { evidencePreparationRunId: firstPrep.id },
    });
    expect(run?.includedEvidenceCount).toBe(1);
  });

  it("deduplicates successful inference for the same preparation run", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Dedupe", slug: `dedupe-${randomUUID()}` },
    });
    process.env.SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID = workspace.id;
    await seedWorkspaceWithActiveSpec(workspace.id);
    const incidentId = await ingestMismatch(workspace.id, `evt-${randomUUID()}`);
    const assigned = await assignIncidentToInvestigationGroup(prisma, workspace.id, incidentId);
    if (assigned.status !== "assigned") {
      throw new Error("expected assigned");
    }
    await processEvidencePreparation(prisma, workspace.id, assigned.investigationGroupId);
    const prepRun = await prisma.evidencePreparationRun.findFirst({
      where: { investigationGroupId: assigned.investigationGroupId },
    });
    await processInvestigationInference(prisma, workspace.id, prepRun!.id);
    const second = await processInvestigationInference(prisma, workspace.id, prepRun!.id);
    expect(second).toMatchObject({ status: "skipped", reason: "already_succeeded" });
    const count = await prisma.investigationInferenceRun.count({
      where: { evidencePreparationRunId: prepRun!.id, status: "SUCCEEDED" },
    });
    expect(count).toBe(1);
  });
});
