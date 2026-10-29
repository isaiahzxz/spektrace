import "dotenv/config";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { IncidentSource, ValidationStatus } from "../src/generated/prisma/client";
import { createPrismaClientForUrl } from "../src/lib/db";
import { requireDatabaseUrl } from "../src/lib/env";

const DEMO_WORKSPACE_SLUG = "demo-local";
const DEMO_SOURCE_EVENT_ID = "seed-demo-400-amount-type";

const SOURCE_TEXT = `openapi: 3.1.0
info:
  title: Demo Payments API
  version: 1.0.0
paths:
  /payments:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required:
                - amount
              properties:
                amount:
                  type: integer
                  description: Payment amount in minor units
`;

async function snapshot() {
  const prisma = createPrismaClientForUrl(requireDatabaseUrl());
  const workspace = await prisma.workspace.findUnique({
    where: { slug: DEMO_WORKSPACE_SLUG },
    include: {
      apiSpecs: true,
      incidents: true,
      auditLogs: true,
    },
  });

  const incident = workspace?.incidents.find(
    (row) => row.sourceEventId === DEMO_SOURCE_EVENT_ID,
  );

  return {
    workspaceCount: workspace ? 1 : 0,
    workspaceId: workspace?.id ?? null,
    specCount: workspace?.apiSpecs.length ?? 0,
    specSha: workspace?.apiSpecs[0]?.sourceSha256 ?? null,
    incidentCount: workspace?.incidents.length ?? 0,
    incident,
    auditCount: workspace?.auditLogs.length ?? 0,
    prisma,
  };
}

async function main() {
  execSync("npm run db:seed", { stdio: "inherit" });
  const first = await snapshot();

  execSync("npm run db:seed", { stdio: "inherit" });
  const second = await snapshot();

  console.log("[db:verify-seed] first run counts:", {
    workspaces: first.workspaceCount,
    specs: first.specCount,
    incidents: first.incidentCount,
    auditLogs: first.auditCount,
  });
  console.log("[db:verify-seed] second run counts:", {
    workspaces: second.workspaceCount,
    specs: second.specCount,
    incidents: second.incidentCount,
    auditLogs: second.auditCount,
  });

  if (first.workspaceId !== second.workspaceId) {
    throw new Error("Demo workspace identity changed across seed runs");
  }
  if (second.specCount !== first.specCount || second.incidentCount !== first.incidentCount) {
    throw new Error("Seed created duplicate specs or incidents on second run");
  }
  if (second.auditCount !== first.auditCount) {
    throw new Error("Seed appended duplicate audit events on second run");
  }

  const expectedSha = createHash("sha256").update(SOURCE_TEXT, "utf8").digest("hex");
  if (second.specSha !== expectedSha) {
    throw new Error("Stored spec checksum does not match preserved source text");
  }

  const incident = second.incident;
  if (!incident) {
    throw new Error("Demo incident missing after seed");
  }

  if (incident.statusCode !== 400) {
    throw new Error(`Expected statusCode 400, got ${incident.statusCode}`);
  }
  if (incident.validationStatus !== ValidationStatus.MISMATCH) {
    throw new Error(`Expected validationStatus MISMATCH, got ${incident.validationStatus}`);
  }
  if (incident.status !== "NEEDS_REVIEW") {
    throw new Error(`Expected status NEEDS_REVIEW, got ${incident.status}`);
  }
  if (incident.draftText || incident.approvedAt || incident.approvedBy) {
    throw new Error("Draft/approval fields must remain empty in demo seed");
  }

  const body = incident.sanitizedRequestBody as { amount?: number } | null;
  if (body?.amount !== 12.5) {
    throw new Error("Expected sanitized payload amount 12.5");
  }

  const evidence = incident.validationEvidence as Array<{ keyword?: string }> | null;
  if (!evidence?.length || !evidence.some((e) => e.keyword === "type")) {
    throw new Error("Expected Ajv evidence with integer type mismatch");
  }

  if (incident.source !== IncidentSource.WEBHOOK) {
    throw new Error("Expected demo incident source WEBHOOK");
  }

  await second.prisma.$disconnect();
  console.log("[db:verify-seed] idempotency and demo incident checks passed");
}

main().catch((error) => {
  console.error("[db:verify-seed] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
