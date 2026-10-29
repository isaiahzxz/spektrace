import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuditEventType,
  DeploymentEventStatus,
  EvidencePreparationRunStatus,
  IncidentSource,
  InvestigationInferenceRunStatus,
} from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { getRedisKeyPrefix } from "@/lib/internal-config";
import { resetIncidentQueueForTests } from "@/lib/queue/incident-queue";
import { recordDeploymentEvent, DeploymentImportError } from "@/server/deployment-context/record-event";
import { activateApiSpecRevision, registerApiSpec } from "@/server/repositories/api-specs";
import { assignIncidentToInvestigationGroup } from "@/server/services/assign-incident-investigation-group";
import { processEvidencePreparation } from "@/server/services/process-evidence-preparation";
import { submitIncident } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { importRepositoryContextSnapshot } from "@/server/repository-context/import-snapshot";
import { requestInferenceWithContext } from "@/server/investigation/request-inference-with-context";
import { resetDatabase } from "./helpers/reset-database";

const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());

process.env.SPEKTRACE_REDIS_PREFIX = `${getRedisKeyPrefix()}-test-${randomUUID().slice(0, 8)}`;
process.env.SPEKTRACE_EVIDENCE_PREPARATION_ENABLED = "true";
process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = "true";
process.env.SPEKTRACE_AI_INFERENCE_ADAPTER = "test";

const INTEGRATION = "synthetic-ci";
const REPOSITORY = "synthetic/example-payments";
const COMMIT = "abc1234567890abcdef1234567890abcdef12345678";

describe("deployment context stage 4C", () => {
  beforeEach(async () => {
    await resetIncidentQueueForTests();
    await resetDatabase(prisma);
    process.env.SPEKTRACE_DEPLOYMENT_IMPORT_ALLOWLIST = JSON.stringify([
      { integrationKey: INTEGRATION, apiKey: "payments-api", environment: "default" },
    ]);
    process.env.SPEKTRACE_REPOSITORY_IMPORT_ALLOWLIST = JSON.stringify([
      {
        repository: REPOSITORY,
        apiKey: "payments-api",
        environment: "default",
        allowedPathPrefixes: ["src/"],
      },
    ]);
  });

  afterAll(async () => {
    await resetIncidentQueueForTests();
    await prisma.$disconnect();
  });

  async function seedWorkspace(workspaceId: string) {
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
    await prisma.repositoryServiceFileMapping.create({
      data: {
        workspaceId,
        apiKey: "payments-api",
        environment: "default",
        httpMethod: "POST",
        operationPath: "/payments",
        relativeFilePath: "src/serialize-payment.ts",
        matchMode: "field_identifier",
        identifierToken: "amount",
      },
    });
    return spec;
  }

  async function seedIncident(workspaceId: string, occurredAt: string) {
    const submitted = await submitIncident(prisma, workspaceId, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: `evt-${randomUUID()}`,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt,
      sanitizedRequestBody: { amount: 12.5 },
    });
    await processIncidentValidation(prisma, workspaceId, submitted.incident.id);
    const assigned = await assignIncidentToInvestigationGroup(prisma, workspaceId, submitted.incident.id);
    if (assigned.status !== "assigned") {
      throw new Error("expected assigned group");
    }
    await processEvidencePreparation(prisma, workspaceId, assigned.investigationGroupId);
    const prep = await prisma.evidencePreparationRun.findFirst({
      where: { investigationGroupId: assigned.investigationGroupId },
    });
    expect(prep?.status).toBe(EvidencePreparationRunStatus.EVIDENCE_READY);
    return { incidentId: submitted.incident.id, investigationGroupId: assigned.investigationGroupId, prepId: prep!.id };
  }

  it("records idempotent status events and cites deployment context on explicit rerun", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Deploy", slug: `deploy-${randomUUID()}` },
    });
    process.env.SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID = workspace.id;
    await seedWorkspace(workspace.id);

    const deployId = `deploy-${randomUUID()}`;
    const started = await recordDeploymentEvent(prisma, workspace.id, {
      integrationKey: INTEGRATION,
      sourceDeploymentId: deployId,
      sourceEventId: `${deployId}-started`,
      apiKey: "payments-api",
      environment: "default",
      status: "started",
      sourceReportedAt: "2026-01-15T10:00:00.000Z",
      repository: REPOSITORY,
      commitSha: COMMIT,
      artifactRef: "payments-api:1.0.0",
    });
    expect(started.created).toBe(true);

    const dup = await recordDeploymentEvent(prisma, workspace.id, {
      integrationKey: INTEGRATION,
      sourceDeploymentId: deployId,
      sourceEventId: `${deployId}-started`,
      apiKey: "payments-api",
      environment: "default",
      status: "started",
      sourceReportedAt: "2026-01-15T10:00:00.000Z",
    });
    expect(dup.created).toBe(false);

    const succeeded = await recordDeploymentEvent(prisma, workspace.id, {
      integrationKey: INTEGRATION,
      sourceDeploymentId: deployId,
      sourceEventId: `${deployId}-succeeded`,
      apiKey: "payments-api",
      environment: "default",
      status: "succeeded",
      sourceReportedAt: "2026-01-15T10:05:00.000Z",
    });
    expect(succeeded.created).toBe(true);

    const eventCount = await prisma.deploymentStatusEvent.count({
      where: { workspaceId: workspace.id, deploymentRecordId: started.record!.id },
    });
    expect(eventCount).toBe(2);

    const { incidentId, investigationGroupId, prepId } = await seedIncident(
      workspace.id,
      "2026-01-15T12:00:00.000Z",
    );
    const before = await prisma.incident.findUnique({ where: { id: incidentId } });

    const rerun = await requestInferenceWithContext(prisma, {
      workspaceId: workspace.id,
      investigationGroupId,
      evidencePreparationRunId: prepId,
      includeDeploymentContext: true,
    });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) {
      throw new Error("expected rerun");
    }

    const run = await prisma.investigationInferenceRun.findUnique({ where: { id: rerun.inferenceRunId } });
    expect(run?.status).toBe(InvestigationInferenceRunStatus.SUCCEEDED);
    expect(run?.deploymentContextIncluded).toBe(true);
    expect(run?.deploymentEvidenceRefs).toBeTruthy();

    const output = run?.validatedOutput as { observedFindings?: Array<{ citationIds?: string[] }> };
    const cited = output?.observedFindings?.flatMap((row) => row.citationIds ?? []) ?? [];
    expect(cited.some((id) => id.startsWith("dp-"))).toBe(true);

    const after = await prisma.incident.findUnique({ where: { id: incidentId } });
    expect(after?.validationEvidence).toEqual(before?.validationEvidence);
    expect(after?.approvedAt).toBe(before?.approvedAt);

    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId: workspace.id, eventType: AuditEventType.DEPLOYMENT_EVENT_RECORDED },
    });
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit?.metadata)).not.toContain(COMMIT);
  });

  it("does not activate a referenced api spec revision", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "NoActivate", slug: `noact-${randomUUID()}` },
    });
    const active = await seedWorkspace(workspace.id);
    const other = await registerApiSpec(prisma, {
      workspaceId: workspace.id,
      apiKey: "payments-api",
      name: "Payments v2",
      version: "2.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "demo2.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: "sha-demo-2",
      parsedDocument: { openapi: "3.1.0", paths: {} },
    });

    await recordDeploymentEvent(prisma, workspace.id, {
      integrationKey: INTEGRATION,
      sourceDeploymentId: `deploy-${randomUUID()}`,
      sourceEventId: `evt-${randomUUID()}`,
      apiKey: "payments-api",
      environment: "default",
      status: "succeeded",
      sourceReportedAt: "2026-01-15T10:00:00.000Z",
      apiSpecId: other.id,
    });

    const stillActive = await prisma.apiSpec.findFirst({
      where: { workspaceId: workspace.id, apiKey: "payments-api", environment: "default", isActive: true },
    });
    expect(stillActive?.id).toBe(active.id);
  });

  it("rejects cross-scope apiSpecId references", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Scope", slug: `scope-${randomUUID()}` },
    });
    const otherWorkspace = await prisma.workspace.create({
      data: { name: "Other", slug: `other-${randomUUID()}` },
    });
    const foreign = await registerApiSpec(prisma, {
      workspaceId: otherWorkspace.id,
      apiKey: "payments-api",
      name: "Foreign",
      version: "1.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "f.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: "sha-f",
      parsedDocument: { openapi: "3.1.0", paths: {} },
    });

    await expect(
      recordDeploymentEvent(prisma, workspace.id, {
        integrationKey: INTEGRATION,
        sourceDeploymentId: `deploy-${randomUUID()}`,
        sourceEventId: `evt-${randomUUID()}`,
        apiKey: "payments-api",
        environment: "default",
        status: "succeeded",
        sourceReportedAt: "2026-01-15T10:00:00.000Z",
        apiSpecId: foreign.id,
      }),
    ).rejects.toBeInstanceOf(DeploymentImportError);
  });

  it("pairs repository snapshot commit with deployment evidence when both are selected", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "RepoDeploy", slug: `repodep-${randomUUID()}` },
    });
    process.env.SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID = workspace.id;
    const spec = await seedWorkspace(workspace.id);

    const deployId = `deploy-${randomUUID()}`;
    await recordDeploymentEvent(prisma, workspace.id, {
      integrationKey: INTEGRATION,
      sourceDeploymentId: deployId,
      sourceEventId: `${deployId}-ok`,
      apiKey: "payments-api",
      environment: "default",
      status: "succeeded",
      sourceReportedAt: "2026-01-15T10:00:00.000Z",
      commitSha: COMMIT,
      apiSpecId: spec.id,
    });

    const imported = await importRepositoryContextSnapshot(prisma, workspace.id, {
      repository: REPOSITORY,
      commitSha: COMMIT,
      apiKey: "payments-api",
      environment: "default",
      files: [
        {
          relativePath: "src/serialize-payment.ts",
          content: "export const amount = (value: number) => String(value);",
        },
      ],
    });
    expect(imported.created).toBe(true);

    const { investigationGroupId, prepId } = await seedIncident(workspace.id, "2026-01-15T12:00:00.000Z");

    const rerun = await requestInferenceWithContext(prisma, {
      workspaceId: workspace.id,
      investigationGroupId,
      evidencePreparationRunId: prepId,
      repositoryContextSnapshotId: imported.snapshot.id,
      includeDeploymentContext: true,
    });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) {
      throw new Error("expected rerun");
    }

    const run = await prisma.investigationInferenceRun.findUnique({ where: { id: rerun.inferenceRunId } });
    const output = run?.validatedOutput as { observedFindings?: Array<{ citationIds?: string[] }> };
    const cited = output?.observedFindings?.flatMap((row) => row.citationIds ?? []) ?? [];
    expect(cited.some((id) => id.startsWith("dp-"))).toBe(true);
    expect(cited.some((id) => id.startsWith("rx-"))).toBe(true);
  });

  it("treats out-of-order receipt as separate immutable events ordered by source time", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Order", slug: `order-${randomUUID()}` },
    });
    const deployId = `deploy-${randomUUID()}`;

    await recordDeploymentEvent(prisma, workspace.id, {
      integrationKey: INTEGRATION,
      sourceDeploymentId: deployId,
      sourceEventId: `${deployId}-succeeded`,
      apiKey: "payments-api",
      environment: "default",
      status: "succeeded",
      sourceReportedAt: "2026-01-15T10:05:00.000Z",
    });
    await recordDeploymentEvent(prisma, workspace.id, {
      integrationKey: INTEGRATION,
      sourceDeploymentId: deployId,
      sourceEventId: `${deployId}-started`,
      apiKey: "payments-api",
      environment: "default",
      status: "started",
      sourceReportedAt: "2026-01-15T10:00:00.000Z",
    });

    const events = await prisma.deploymentStatusEvent.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { sourceReportedAt: "asc" },
    });
    expect(events.map((row) => row.status)).toEqual([
      DeploymentEventStatus.STARTED,
      DeploymentEventStatus.SUCCEEDED,
    ]);
  });
});
