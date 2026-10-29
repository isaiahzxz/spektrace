import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireDatabaseUrl } from "@/lib/env";
import { forwardApplicationHttpFailure } from "@/lib/ingestion/application-monitoring";
import {
  EvidencePreparationRunStatus,
  ValidationStatus,
} from "@/generated/prisma/client";

const baseUrl = process.env.SPEKTRACE_DEMO_BASE_URL ?? "http://127.0.0.1:3000";
function requireSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Missing ingestion token, internal token, or pilot workspace id in environment");
  return value;
}
const ingestionToken = requireSetting("SPEKTRACE_INGESTION_API_TOKEN");
const internalToken = requireSetting("SPEKTRACE_INTERNAL_API_TOKEN");
const workspaceId = requireSetting("SPEKTRACE_INTERNAL_WORKSPACE_ID");
const runId = randomUUID().slice(0, 8);
const sourceEventId = `dev-activation-${runId}`;
const occurredAt = "2026-10-22T03:45:00.000Z";

const failure = {
  sourceEventId,
  httpMethod: "POST",
  requestPath: "/payments",
  statusCode: 400,
  occurredAt,
  sanitizedRequestBody: { amount: "100" },
  clientReference: `dev-activation-${runId}`,
  client: {
    applicationName: "Synthetic Payments API",
    applicationVersion: "dev-activation-1",
    platform: "node",
  },
};

const db = createPrismaClientForUrl(requireDatabaseUrl());
const report: Record<string, unknown> & { checks: Record<string, unknown> } = {
  baseUrl,
  workspaceId,
  sourceEventId,
  occurredAt,
  checks: {} as Record<string, unknown>,
};

async function postJson(path: string, bearer: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function main() {
try {
  const first = await forwardApplicationHttpFailure(
    { baseUrl, bearerToken: ingestionToken },
    { apiKey: "payments-api", environment: "default" },
    failure,
  );
  report.checks = { firstIngest: first };

  if (!first.ok) {
    throw new Error(`first ingest failed: ${first.code}`);
  }

  report.checks.minimalReceipt202 = {
    status: first.httpStatus,
    hasOnlyReceipt: first.ok && first.created && first.httpStatus === 202,
  };

  const invalid = await forwardApplicationHttpFailure(
    { baseUrl, bearerToken: "invalid-ingestion-token-invalid-ingestion" },
    { apiKey: "payments-api" },
    { ...failure, sourceEventId: `denied-${runId}` },
  );
  report.checks.invalidCredential = invalid;

  const adminSubmit = await postJson("/api/internal/incidents", internalToken, {
    source: "WEBHOOK",
    sourceEventId: `admin-denied-${runId}`,
    apiKey: "payments-api",
    environment: "default",
    httpMethod: "POST",
    requestPath: "/payments",
    statusCode: 400,
    occurredAt,
    sanitizedRequestBody: { amount: "100" },
  });
  report.checks.adminSubmitRejected = { status: adminSubmit.status };

  const readDenied = await fetch(`${baseUrl}/api/internal/incidents/${first.incidentId}`, {
    headers: { Authorization: `Bearer ${ingestionToken}` },
  }).then(async (response) => ({ status: response.status }));
  report.checks.ingestionCannotRead = { status: readDenied.status };

  const activateDenied = await postJson("/api/internal/specs/activate", ingestionToken, {
    specId: "00000000-0000-0000-0000-000000000001",
  });
  report.checks.ingestionCannotActivate = { status: activateDenied.status };

  const deadline = Date.now() + 90_000;
  let stage = "pending";
  while (Date.now() < deadline) {
    const incident = await db.incident.findUnique({ where: { id: first.incidentId } });
    if (!incident) break;
    if (incident.workspaceId !== workspaceId) {
      stage = "wrong_workspace";
      break;
    }
    if (incident.validationStatus === ValidationStatus.MISMATCH) {
      stage = "validated";
    }
    const group = await db.investigationGroupMembership.findFirst({
      where: { incidentId: first.incidentId },
    });
    if (group) {
      stage = "grouped";
      const prep = await db.evidencePreparationRun.findFirst({
        where: { investigationGroupId: group.investigationGroupId },
        orderBy: { createdAt: "desc" },
      });
      if (prep?.status === EvidencePreparationRunStatus.EVIDENCE_READY) {
        stage = "evidence_ready";
        report.observed = {
          incidentId: first.incidentId,
          validationStatus: incident.validationStatus,
          apiKey: incident.apiKey,
          environment: incident.environment,
          investigationGroupId: group.investigationGroupId,
          evidencePreparationStatus: prep.status,
          aiInvestigationPerformed: (prep.protectedSummary as { aiInvestigationPerformed?: boolean })
            ?.aiInvestigationPerformed,
          inferenceRuns: await db.investigationInferenceRun.count({ where: { workspaceId } }),
          approvalStatus: incident.status,
        };
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  report.checks.pipelineStage = stage;

  const membership = await db.investigationGroupMembership.findFirst({
    where: { incidentId: first.incidentId },
  });
  const before = {
    audits: await db.auditLog.count({ where: { incidentId: first.incidentId } }),
    prepRuns: membership
      ? await db.evidencePreparationRun.count({
          where: { investigationGroupId: membership.investigationGroupId },
        })
      : 0,
  };
  report.checks.processingBeforeRetry = before;

  const second = await forwardApplicationHttpFailure(
    { baseUrl, bearerToken: ingestionToken },
    { apiKey: "payments-api", environment: "default" },
    failure,
  );
  report.checks.secondIngest = second;

  const after = {
    audits: await db.auditLog.count({ where: { incidentId: first.incidentId } }),
    prepRuns: membership
      ? await db.evidencePreparationRun.count({
          where: { investigationGroupId: membership.investigationGroupId },
        })
      : 0,
  };
  report.checks.processingAfterRetry = after;
  report.checks.duplicateProcessingUnchanged =
    JSON.stringify(before) === JSON.stringify(after) && second.ok && second.deduplicated;

  report.dashboardUrl = `${baseUrl}/dashboard?incident=${first.incidentId}&inspect=1`;
  report.verdict =
    stage === "evidence_ready" &&
    second.ok &&
    second.deduplicated &&
    invalid.ok === false &&
    adminSubmit.status === 401 &&
    readDenied.status === 401 &&
    activateDenied.status === 401
      ? "demonstrated"
      : "partial_or_blocked";

  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.$disconnect();
}
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
