import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuditEventType,
  EvidencePreparationRunStatus,
  IncidentSource,
  InvestigationInferenceRunStatus,
} from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { getRedisKeyPrefix } from "@/lib/internal-config";
import { resetIncidentQueueForTests } from "@/lib/queue/incident-queue";
import { activateApiSpecRevision, registerApiSpec } from "@/server/repositories/api-specs";
import { assignIncidentToInvestigationGroup } from "@/server/services/assign-incident-investigation-group";
import { processEvidencePreparation } from "@/server/services/process-evidence-preparation";
import { submitIncident } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { importRepositoryContextSnapshot } from "@/server/repository-context/import-snapshot";
import { requestInferenceWithRepositorySnapshot } from "@/server/repository-context/request-inference-with-snapshot";
import { resetDatabase } from "./helpers/reset-database";

const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());

process.env.SPEKTRACE_REDIS_PREFIX = `${getRedisKeyPrefix()}-test-${randomUUID().slice(0, 8)}`;
process.env.SPEKTRACE_EVIDENCE_PREPARATION_ENABLED = "true";
process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = "true";
process.env.SPEKTRACE_AI_INFERENCE_ADAPTER = "test";

const REPOSITORY = "synthetic/example-payments";
const SOURCE = [
  "export function serializePayment(input: { amount: number }) {",
  "  const api_key = 'must-not-persist';",
  "  return JSON.stringify({ amount: String(input.amount) });",
  "}",
].join("\n");

describe("repository context stage 4A", () => {
  beforeEach(async () => {
    await resetIncidentQueueForTests();
    await resetDatabase(prisma);
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
  }

  it("imports, retrieves excerpts, and cites them in a bounded repository rerun", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Repo", slug: `repo-${randomUUID()}` },
    });
    process.env.SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID = workspace.id;
    await seedWorkspace(workspace.id);

    const imported = await importRepositoryContextSnapshot(prisma, workspace.id, {
      apiKey: "payments-api",
      environment: "default",
      repository: REPOSITORY,
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      files: [{ relativePath: "src/serialize-payment.ts", content: SOURCE }],
    });
    expect(imported.created).toBe(true);
    expect(imported.rejected).toEqual([]);

    const storedFile = await prisma.repositorySnapshotFile.findFirst({
      where: { snapshotId: imported.snapshot.id },
    });
    expect(storedFile?.sanitizedText).toContain("[REDACTED:");
    expect(storedFile?.sanitizedText).not.toContain("must-not-persist");

    const submitted = await submitIncident(prisma, workspace.id, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: `evt-${randomUUID()}`,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    });
    await processIncidentValidation(prisma, workspace.id, submitted.incident.id);
    const assigned = await assignIncidentToInvestigationGroup(prisma, workspace.id, submitted.incident.id);
    if (assigned.status !== "assigned") {
      throw new Error("expected assigned group");
    }
    await processEvidencePreparation(prisma, workspace.id, assigned.investigationGroupId);
    const prep = await prisma.evidencePreparationRun.findFirst({
      where: { investigationGroupId: assigned.investigationGroupId },
    });
    expect(prep?.status).toBe(EvidencePreparationRunStatus.EVIDENCE_READY);

    const before = await prisma.incident.findUnique({ where: { id: submitted.incident.id } });

    const rerun = await requestInferenceWithRepositorySnapshot(prisma, {
      workspaceId: workspace.id,
      investigationGroupId: assigned.investigationGroupId,
      repositoryContextSnapshotId: imported.snapshot.id,
      evidencePreparationRunId: prep!.id,
    });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) {
      throw new Error("expected rerun success");
    }

    const run = await prisma.investigationInferenceRun.findUnique({ where: { id: rerun.inferenceRunId } });
    expect(run?.status).toBe(InvestigationInferenceRunStatus.SUCCEEDED);
    expect(run?.repositoryContextSnapshotId).toBe(imported.snapshot.id);
    expect(run?.repositoryExcerptRefs).toBeTruthy();

    const after = await prisma.incident.findUnique({ where: { id: submitted.incident.id } });
    expect(after?.validationStatus).toBe(before?.validationStatus);
    expect(after?.validationEvidence).toEqual(before?.validationEvidence);
    expect(after?.status).toBe(before?.status);
    expect(after?.approvedAt).toBe(before?.approvedAt);
    expect(after?.draftText).toBe(before?.draftText);

    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId: workspace.id, eventType: AuditEventType.REPOSITORY_SNAPSHOT_IMPORTED },
    });
    expect(audit?.metadata).toMatchObject({
      repository: REPOSITORY,
      fileCount: 1,
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain("must-not-persist");
  });

  it("rejects imports outside the workspace allowlist", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Denied", slug: `denied-${randomUUID()}` },
    });
    await expect(
      importRepositoryContextSnapshot(prisma, workspace.id, {
        apiKey: "payments-api",
        repository: "other/repo",
        commitSha: "abcdef1234567890abcdef1234567890abcdef12",
        files: [{ relativePath: "src/a.ts", content: "export const x = 1;" }],
      }),
    ).rejects.toMatchObject({ code: "NOT_ALLOWLISTED" });
  });

  it("replays identical imports idempotently", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "Replay", slug: `replay-${randomUUID()}` },
    });
    const payload = {
      apiKey: "payments-api",
      environment: "default" as const,
      repository: REPOSITORY,
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      files: [{ relativePath: "src/serialize-payment.ts", content: SOURCE }],
    };
    const first = await importRepositoryContextSnapshot(prisma, workspace.id, payload);
    const second = await importRepositoryContextSnapshot(prisma, workspace.id, payload);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(
      await prisma.auditLog.count({
        where: { workspaceId: workspace.id, eventType: AuditEventType.REPOSITORY_SNAPSHOT_IMPORTED },
      }),
    ).toBe(1);
  });
});
