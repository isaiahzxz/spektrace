import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EvidencePreparationRunStatus,
  ValidationStatus,
} from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import {
  buildApplicationMonitoringEnvelope,
  forwardApplicationHttpFailure,
} from "@/lib/ingestion/application-monitoring";
import { activateApiSpecRevision, registerApiSpec } from "@/server/repositories/api-specs";
import { assignIncidentToInvestigationGroup } from "@/server/services/assign-incident-investigation-group";
import { processEvidencePreparation } from "@/server/services/process-evidence-preparation";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";

const db = createPrismaClientForUrl(requireTestDatabaseUrl());

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getPrisma: () => db };
});

let TEST_TOKEN: string;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type Baseline = { incidents: string[]; audits: string[]; digest: string };
let baseline: Baseline;
let savedToken: string | undefined;
let savedWorkspaceId: string | undefined;
let savedEvidencePrep: string | undefined;
let savedAi: string | undefined;

async function snapshotBaseline(ids?: Pick<Baseline, "incidents" | "audits">) {
  const incidents = await db.incident.findMany({
    where: ids ? { id: { in: ids.incidents } } : {},
    orderBy: { id: "asc" },
  });
  const audits = await db.auditLog.findMany({
    where: ids ? { id: { in: ids.audits } } : {},
    orderBy: { id: "asc" },
  });
  return { incidents, audits };
}

async function seedPaymentsSpec(workspaceId: string) {
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
  const spec = await registerApiSpec(db, {
    workspaceId,
    apiKey: "payments-api",
    environment: "default",
    name: "Synthetic appmon payments",
    version: "1.0.0",
    openApiVersion: "3.1.0",
    sourceFilename: "appmon-payments.json",
    sourceText,
    sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
    parsedDocument: document,
  });
  await activateApiSpecRevision(db, workspaceId, spec.id);
  return spec;
}

function syntheticFailure(sourceEventId: string) {
  return {
    sourceEventId,
    httpMethod: "POST",
    requestPath: "/payments",
    statusCode: 400,
    occurredAt: new Date().toISOString(),
    sanitizedRequestBody: { amount: "100" },
    clientReference: "synthetic-appmon-integration",
    client: {
      applicationName: "Synthetic Payments API",
      applicationVersion: "demo-1",
      platform: "node",
    },
  };
}

async function ingestViaRoute(sourceEventId: string, bearerToken: string = TEST_TOKEN) {
  const { POST } = await import("@/app/api/internal/incidents/route");
  const built = buildApplicationMonitoringEnvelope(syntheticFailure(sourceEventId), {
    apiKey: "payments-api",
    environment: "default",
  });
  if (!built.ok) {
    throw new Error(built.message);
  }
  const response = await POST(
    new Request("http://internal.test/api/internal/incidents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(built.envelope),
    }),
  );
  return response;
}

beforeAll(async () => {
  savedToken = process.env.SPEKTRACE_INTERNAL_API_TOKEN;
  savedWorkspaceId = process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID;
  savedEvidencePrep = process.env.SPEKTRACE_EVIDENCE_PREPARATION_ENABLED;
  savedAi = process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED;
  process.env.SPEKTRACE_EVIDENCE_PREPARATION_ENABLED = "true";
  process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = "false";
  const before = await snapshotBaseline();
  baseline = {
    incidents: before.incidents.map((row) => row.id),
    audits: before.audits.map((row) => row.id),
    digest: hash(before),
  };
});

afterAll(async () => {
  try {
    expect(hash(await snapshotBaseline(baseline))).toBe(baseline.digest);
  } finally {
    if (savedToken === undefined) {
      delete process.env.SPEKTRACE_INTERNAL_API_TOKEN;
    } else {
      process.env.SPEKTRACE_INTERNAL_API_TOKEN = savedToken;
    }
    if (savedWorkspaceId === undefined) {
      delete process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID;
    } else {
      process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID = savedWorkspaceId;
    }
    if (savedEvidencePrep === undefined) {
      delete process.env.SPEKTRACE_EVIDENCE_PREPARATION_ENABLED;
    } else {
      process.env.SPEKTRACE_EVIDENCE_PREPARATION_ENABLED = savedEvidencePrep;
    }
    if (savedAi === undefined) {
      delete process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED;
    } else {
      process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = savedAi;
    }
    await db.$disconnect();
  }
});

describe("non-reset synthetic application monitoring adapter", () => {
  it("forwards a 4xx failure through ingestion into pinned validation, grouping, and protected evidence", async () => {
    const workspace = await db.workspace.create({
      data: { name: "Appmon path", slug: `appmon-path-${randomUUID()}` },
    });
    const decoy = await db.workspace.create({
      data: { name: "Appmon decoy", slug: `appmon-decoy-${randomUUID()}` },
    });
    await seedPaymentsSpec(workspace.id);
    TEST_TOKEN = (await issueIngestionCredential(db, workspace.id, "Appmon path")).token;
    process.env.SPEKTRACE_INTERNAL_API_TOKEN = TEST_TOKEN;
    process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID = workspace.id;

    const eventId = `appmon-path-${randomUUID()}`;
    const response = await ingestViaRoute(eventId);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { id: string };
    expect(body.id).toBeTruthy();

    const incident = await db.incident.findUniqueOrThrow({ where: { id: body.id } });
    expect(incident.workspaceId).toBe(workspace.id);
    expect(incident.apiSpecId).toBeTruthy();
    expect(incident.sanitizedRequestBody).toEqual({ amount: "100" });

    await processIncidentValidation(db, workspace.id, incident.id);
    const validated = await db.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(validated.validationStatus).toBe(ValidationStatus.MISMATCH);
    const evidence = validated.validationEvidence as { plainEnglishSummary?: string } | null;
    expect(evidence?.plainEnglishSummary).toContain("whole number");

    const assigned = await assignIncidentToInvestigationGroup(db, workspace.id, incident.id);
    expect(assigned.status).toBe("assigned");
    if (assigned.status !== "assigned") {
      return;
    }

    const prepared = await processEvidencePreparation(
      db,
      workspace.id,
      assigned.investigationGroupId,
    );
    expect(prepared).toMatchObject({
      status: "processed",
      runStatus: EvidencePreparationRunStatus.EVIDENCE_READY,
    });
    const run = await db.evidencePreparationRun.findFirst({
      where: { investigationGroupId: assigned.investigationGroupId },
    });
    const summary = run?.protectedSummary as { aiInvestigationPerformed?: boolean };
    expect(summary?.aiInvestigationPerformed).toBe(false);

    const decoyCount = await db.incident.count({
      where: { workspaceId: decoy.id, sourceEventId: eventId },
    });
    expect(decoyCount).toBe(0);
  });

  it("deduplicates identical adapter retries and rejects wrong bearer tokens", async () => {
    const workspace = await db.workspace.create({
      data: { name: "Appmon dedupe", slug: `appmon-dedupe-${randomUUID()}` },
    });
    await seedPaymentsSpec(workspace.id);
    TEST_TOKEN = (await issueIngestionCredential(db, workspace.id, "Appmon dedupe")).token;
    process.env.SPEKTRACE_INTERNAL_API_TOKEN = TEST_TOKEN;
    process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID = workspace.id;

    const eventId = `appmon-dedupe-${randomUUID()}`;
    const occurredAt = "2026-06-01T12:00:00.000Z";
    const failure = { ...syntheticFailure(eventId), occurredAt };
    const fetchImpl: typeof fetch = async (input, init) => {
      const { POST } = await import("@/app/api/internal/incidents/route");
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return POST(new Request(url, init));
    };

    const first = await forwardApplicationHttpFailure(
      { baseUrl: "http://internal.test", bearerToken: TEST_TOKEN },
      { apiKey: "payments-api", environment: "default" },
      failure,
      { fetchImpl },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.created).toBe(true);
    expect(first.deduplicated).toBe(false);

    const second = await forwardApplicationHttpFailure(
      { baseUrl: "http://internal.test", bearerToken: TEST_TOKEN },
      { apiKey: "payments-api", environment: "default" },
      failure,
      { fetchImpl },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.incidentId).toBe(first.incidentId);
    expect(second.deduplicated).toBe(true);

    const rows = await db.incident.count({
      where: { workspaceId: workspace.id, sourceEventId: eventId },
    });
    expect(rows).toBe(1);

    const beforeWrong = await db.incident.count({ where: { workspaceId: workspace.id } });
    const denied = await forwardApplicationHttpFailure(
      { baseUrl: "http://internal.test", bearerToken: "wrong-token-wrong-token-wrong-token!!" },
      { apiKey: "payments-api" },
      syntheticFailure(`appmon-denied-${randomUUID()}`),
      { fetchImpl },
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.code).toBe("APPMON_INGEST_UNAUTHORIZED");
    const afterWrong = await db.incident.count({ where: { workspaceId: workspace.id } });
    expect(afterWrong).toBe(beforeWrong);
  });
});
