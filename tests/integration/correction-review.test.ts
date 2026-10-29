import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuditEventType, IncidentSource, ValidationStatus } from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { filterWhere } from "@/server/dashboard/incident-review-data";
import { activateApiSpecRevision, registerApiSpec } from "@/server/repositories/api-specs";
import { applyAcceptance, acceptTestedCorrection, LOCAL_PILOT_ACTOR } from "@/server/review/correction";
import { assignPatternSeverity } from "@/server/review/severity";
import { submitIncident } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { dispatchOutboxBatch } from "@/server/outbox/dispatcher";
import { resetDatabase } from "./helpers/reset-database";

const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());
const passing = '{\n  "amount": 1\n}';

describe("tested correction acceptance", () => {
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function spec(workspaceId: string, version: string, required: string[]) {
    const created = await registerApiSpec(prisma, {
      workspaceId,
      apiKey: "payments-api",
      name: "Payments",
      version,
      openApiVersion: "3.1.0",
      sourceFilename: "payments.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: `sha-${version}`,
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
                      required,
                      properties: {
                        amount: { type: "integer" },
                        currency: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    return created;
  }

  async function incident(workspaceId: string) {
    const submitted = await submitIncident(prisma, workspaceId, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: `evt-${randomUUID()}`,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: "ten" },
    });
    await dispatchOutboxBatch(prisma);
    await processIncidentValidation(prisma, workspaceId, submitted.incident.id);
    return submitted.incident.id;
  }

  it("accepts one passing candidate and leaves the original evidence unchanged", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Accept", slug: `accept-${randomUUID()}` } });
    await activateApiSpecRevision(prisma, workspace.id, (await spec(workspace.id, "1.0.0", ["amount"])).id);
    const id = await incident(workspace.id);
    const before = await prisma.incident.findUniqueOrThrow({ where: { id } });

    const [first, second] = await Promise.all([
      acceptTestedCorrection(prisma, workspace.id, { incidentId: id, candidateText: passing, revision: "pinned" }),
      acceptTestedCorrection(prisma, workspace.id, { incidentId: id, candidateText: passing, revision: "pinned" }),
    ]);
    expect(first.ok || second.ok).toBe(true);

    const after = await prisma.incident.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe("APPROVED");
    expect(after.validationStatus).toBe(ValidationStatus.MISMATCH);
    expect(after.validationEvidence).toEqual(before.validationEvidence);
    expect(after.sanitizedRequestBody).toEqual(before.sanitizedRequestBody);
    expect(after.approvedBy).toBe(LOCAL_PILOT_ACTOR);

    const approvals = await prisma.auditLog.findMany({
      where: { incidentId: id, eventType: AuditEventType.INCIDENT_APPROVED },
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.actorType).toBe("HUMAN");
    expect(approvals[0]?.actorId).toBe(LOCAL_PILOT_ACTOR);
    expect(JSON.stringify(approvals[0]?.metadata)).toContain("Local pilot operator");
    expect(JSON.stringify(approvals[0]?.metadata)).not.toContain("ten");

    const active = await prisma.incident.count({ where: { workspaceId: workspace.id, ...filterWhere("all") } });
    const history = await prisma.incident.count({ where: { workspaceId: workspace.id, ...filterWhere("history") } });
    expect(active).toBe(0);
    expect(history).toBe(1);

    const retry = await acceptTestedCorrection(prisma, workspace.id, {
      incidentId: id,
      candidateText: passing,
      revision: "pinned",
    });
    expect(retry.ok).toBe(true);
    expect(await prisma.auditLog.count({ where: { incidentId: id, eventType: "INCIDENT_APPROVED" } })).toBe(1);
  });

  it("refuses a failing candidate, another workspace, and a changed active revision", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Refuse", slug: `refuse-${randomUUID()}` } });
    const other = await prisma.workspace.create({ data: { name: "Other", slug: `other-${randomUUID()}` } });
    const first = await spec(workspace.id, "1.0.0", ["amount"]);
    await activateApiSpecRevision(prisma, workspace.id, first.id);
    const id = await incident(workspace.id);
    const before = await prisma.incident.findUniqueOrThrow({ where: { id } });

    const failed = await acceptTestedCorrection(prisma, workspace.id, {
      incidentId: id,
      candidateText: '{"amount":"ten"}',
      revision: "pinned",
    });
    expect(failed.ok).toBe(false);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id } })).status).toBe(before.status);

    const foreign = await acceptTestedCorrection(prisma, other.id, {
      incidentId: id,
      candidateText: passing,
      revision: "pinned",
    });
    expect(foreign.ok).toBe(false);

    const stricter = await spec(workspace.id, "2.0.0", ["amount", "currency"]);
    await activateApiSpecRevision(prisma, workspace.id, stricter.id);
    const activeNow = await acceptTestedCorrection(prisma, workspace.id, {
      incidentId: id,
      candidateText: passing,
      revision: "active",
    });
    expect(activeNow.ok).toBe(false);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id } })).status).not.toBe("APPROVED");

    const pinned = await acceptTestedCorrection(prisma, workspace.id, {
      incidentId: id,
      candidateText: passing,
      revision: "pinned",
    });
    expect(pinned.ok).toBe(true);
    const saved = await prisma.incident.findUniqueOrThrow({ where: { id } });
    expect(saved.validationStatus).toBe(ValidationStatus.MISMATCH);
    expect(saved.apiSpecId).toBe(first.id);
  });

  it("does not accept an unsupported specification", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Old", slug: `old-${randomUUID()}` } });
    const created = await registerApiSpec(prisma, {
      workspaceId: workspace.id,
      apiKey: "payments-api",
      name: "Payments",
      version: "0.9.0",
      openApiVersion: "3.0.3",
      sourceFilename: "payments.yaml",
      sourceText: "openapi: 3.0.3",
      sourceSha256: "sha-old",
      parsedDocument: { openapi: "3.0.3", paths: {} },
    });
    await activateApiSpecRevision(prisma, workspace.id, created.id);
    const id = await incident(workspace.id);
    const refused = await acceptTestedCorrection(prisma, workspace.id, {
      incidentId: id,
      candidateText: passing,
      revision: "pinned",
    });
    expect(refused.ok).toBe(false);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id } })).status).not.toBe("APPROVED");
    expect(await prisma.auditLog.count({ where: { incidentId: id, eventType: "INCIDENT_APPROVED" } })).toBe(0);
  });

  it("rolls back the approval and the audit event together", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Rollback", slug: `rollback-${randomUUID()}` } });
    await activateApiSpecRevision(prisma, workspace.id, (await spec(workspace.id, "1.0.0", ["amount"])).id);
    const id = await incident(workspace.id);

    await expect(
      prisma.$transaction(async (tx) => {
        const result = await applyAcceptance(tx, workspace.id, {
          incidentId: id,
          candidateText: passing,
          revision: "pinned",
        });
        expect(result.ok).toBe(true);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    const saved = await prisma.incident.findUniqueOrThrow({ where: { id } });
    expect(saved.status).not.toBe("APPROVED");
    expect(saved.approvedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { incidentId: id, eventType: "INCIDENT_APPROVED" } })).toBe(0);
  });

  it("stores a manual severity only in that workspace", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Severity", slug: `sev-${randomUUID()}` } });
    const other = await prisma.workspace.create({ data: { name: "Elsewhere", slug: `else-${randomUUID()}` } });
    const key = "spec\u001fPOST\u001f/payments\u001f/amount\u001fType\u001finteger";
    const saved = await assignPatternSeverity(prisma, workspace.id, { patternKey: key, severity: "HIGH" });
    expect(saved.ok).toBe(true);
    const row = await prisma.patternSeverityAssignment.findUnique({
      where: { workspaceId_patternKey: { workspaceId: workspace.id, patternKey: key } },
    });
    expect(row?.severity).toBe("HIGH");
    expect(row?.provenance).toBe("manual");
    expect(
      await prisma.patternSeverityAssignment.findUnique({
        where: { workspaceId_patternKey: { workspaceId: other.id, patternKey: key } },
      }),
    ).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId: workspace.id, eventType: "PATTERN_SEVERITY_SET" },
    });
    expect(audit?.actorId).toBe(LOCAL_PILOT_ACTOR);
    expect(JSON.stringify(audit?.metadata)).toContain("Human assignment");
  });
});
