import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { IncidentSource, InvestigationInferenceRunStatus } from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { getRedisKeyPrefix } from "@/lib/internal-config";
import { extractBearerToken } from "@/lib/http/internal-api";
import { verifyInternalApiToken } from "@/lib/internal-config";
import { resetIncidentQueueForTests } from "@/lib/queue/incident-queue";
import { loadIncidentAiExplanation } from "@/server/dashboard/incident-inference-data";
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

describe("inference verification boundaries (fixtures)", () => {
  beforeEach(async () => {
    await resetIncidentQueueForTests();
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetIncidentQueueForTests();
    await prisma.$disconnect();
  });

  async function seedAndPrepare(workspaceId: string) {
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
    const submitted = await submitIncident(prisma, workspaceId, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: `evt-${randomUUID()}`,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    });
    await processIncidentValidation(prisma, workspaceId, submitted.incident.id);
    const assigned = await assignIncidentToInvestigationGroup(prisma, workspaceId, submitted.incident.id);
    if (assigned.status !== "assigned") {
      throw new Error("expected assigned");
    }
    await processEvidencePreparation(prisma, workspaceId, assigned.investigationGroupId);
    const prep = await prisma.evidencePreparationRun.findFirst({
      where: { investigationGroupId: assigned.investigationGroupId },
    });
    return { incidentId: submitted.incident.id, prepId: prep!.id, specId: spec.id };
  }

  it("rejects invalid internal API tokens (authorization)", () => {
    const configured = process.env.SPEKTRACE_INTERNAL_API_TOKEN?.trim();
    if (!configured) {
      expect(extractBearerToken("Bearer missing-config")).toBe("missing-config");
      return;
    }
    expect(verifyInternalApiToken("definitely-wrong-token", configured)).toBe(false);
    expect(verifyInternalApiToken(null, configured)).toBe(false);
  });

  it("does not surface rejected model output in the incident inspector", async () => {
    process.env.SPEKTRACE_AI_INFERENCE_ADAPTER = "test";
    process.env.SPEKTRACE_AI_TEST_ADAPTER_FORCE_UNKNOWN_CITATION = "1";
    const workspace = await prisma.workspace.create({
      data: { name: "Reject", slug: `reject-${randomUUID()}` },
    });
    process.env.SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID = workspace.id;
    const { incidentId, prepId } = await seedAndPrepare(workspace.id);
    const processed = await processInvestigationInference(prisma, workspace.id, prepId);
    expect(processed.status).toBe("processed");
    if (processed.status !== "processed") {
      throw new Error("expected processed");
    }
    expect(processed.runStatus).toBe(InvestigationInferenceRunStatus.FAILED);
    const view = await loadIncidentAiExplanation(prisma, workspace.id, incidentId);
    expect(view.state).toBe("failed");
    if (view.state === "failed") {
      expect(view.failureCode).toBeTruthy();
    }
    delete process.env.SPEKTRACE_AI_TEST_ADAPTER_FORCE_UNKNOWN_CITATION;
  });

  it("records a non-retryable gateway configuration failure without mutating incidents", async () => {
    process.env.SPEKTRACE_AI_INFERENCE_ADAPTER = "gateway";
    delete process.env.THESYS_API_KEY;
    const workspace = await prisma.workspace.create({
      data: { name: "Gateway", slug: `gw-${randomUUID()}` },
    });
    process.env.SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID = workspace.id;
    const { incidentId, prepId, specId } = await seedAndPrepare(workspace.id);
    const before = await prisma.incident.findUnique({ where: { id: incidentId } });
    const activeBefore = await prisma.apiSpec.findFirst({
      where: { id: specId, isActive: true },
    });
    const processed = await processInvestigationInference(prisma, workspace.id, prepId);
    expect(processed.status).toBe("processed");
    if (processed.status !== "processed") {
      throw new Error("expected processed");
    }
    expect(processed.runStatus).toBe(InvestigationInferenceRunStatus.FAILED);
    const run = await prisma.investigationInferenceRun.findUnique({ where: { id: processed.runId } });
    expect(run?.failureCode).toBe("GATEWAY_NOT_CONFIGURED");
    const after = await prisma.incident.findUnique({ where: { id: incidentId } });
    expect(after?.validationEvidence).toEqual(before?.validationEvidence);
    expect(after?.approvedAt).toBeNull();
    const activeAfter = await prisma.apiSpec.findFirst({ where: { id: specId, isActive: true } });
    expect(activeAfter?.id).toBe(activeBefore?.id);
    process.env.SPEKTRACE_AI_INFERENCE_ADAPTER = "test";
  });
});
