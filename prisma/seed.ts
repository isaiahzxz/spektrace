import "dotenv/config";
import { createHash } from "node:crypto";
import {
  ActorType,
  AuditEventType,
  IncidentSource,
  IncidentStatus,
  ValidationStatus,
} from "../src/generated/prisma/client";
import { appendAuditLog } from "../src/lib/audit/append-audit-log";
import { createPrismaClientForUrl } from "../src/lib/db";
import { requireDatabaseUrl } from "../src/lib/env";
import { activateApiSpecRevision, registerApiSpec } from "../src/server/repositories/api-specs";
import { createIncident } from "../src/server/repositories/incidents";
import { validateJsonSchemaPayload } from "../src/lib/validation/validate-json-schema";

const DEMO_WORKSPACE_SLUG = "demo-local";
const DEMO_API_KEY = "payments-api";
const DEMO_SPEC_VERSION = "1.0.0";
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

const REQUEST_BODY_SCHEMA = {
  type: "object",
  required: ["amount"],
  properties: {
    amount: { type: "integer", description: "Payment amount in minor units" },
  },
} as const;

const SANITIZED_BODY = { amount: 12.5 };

async function main() {
  const prisma = createPrismaClientForUrl(requireDatabaseUrl());
  try {

  const workspace = await prisma.workspace.upsert({
    where: { slug: DEMO_WORKSPACE_SLUG },
    update: { name: "SpekTrace Demo (local)" },
    create: {
      slug: DEMO_WORKSPACE_SLUG,
      name: "SpekTrace Demo (local)",
    },
  });

  const sourceSha256 = createHash("sha256").update(SOURCE_TEXT, "utf8").digest("hex");
  const parsedDocument = {
    openapi: "3.1.0",
    info: { title: "Demo Payments API", version: "1.0.0" },
    paths: {
      "/payments": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: REQUEST_BODY_SCHEMA,
              },
            },
          },
        },
      },
    },
  };

  let apiSpec = await prisma.apiSpec.findFirst({
    where: {
      workspaceId: workspace.id,
      apiKey: DEMO_API_KEY,
      version: DEMO_SPEC_VERSION,
    },
  });

  if (!apiSpec) {
    apiSpec = await registerApiSpec(prisma, {
      workspaceId: workspace.id,
      apiKey: DEMO_API_KEY,
      name: "Demo Payments API",
      version: DEMO_SPEC_VERSION,
      openApiVersion: "3.1.0",
      sourceFilename: "demo-payments.openapi.yaml",
      sourceText: SOURCE_TEXT,
      sourceSha256,
      parsedDocument,
      activate: false,
    });
    await activateApiSpecRevision(prisma, workspace.id, apiSpec.id);
  }

  const validation = validateJsonSchemaPayload(REQUEST_BODY_SCHEMA, SANITIZED_BODY);
  if (validation.status !== "mismatch") {
    throw new Error(`Expected seed validation mismatch, received ${validation.status}`);
  }

  const existingIncident = await prisma.incident.findUnique({
    where: {
      workspaceId_source_sourceEventId: {
        workspaceId: workspace.id,
        source: IncidentSource.WEBHOOK,
        sourceEventId: DEMO_SOURCE_EVENT_ID,
      },
    },
  });

  if (!existingIncident) {
    const incident = await createIncident(prisma, {
      workspaceId: workspace.id,
      apiKey: DEMO_API_KEY,
      apiSpecId: apiSpec.id,
      source: IncidentSource.WEBHOOK,
      sourceEventId: DEMO_SOURCE_EVENT_ID,
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      sanitizedRequestBody: SANITIZED_BODY,
      status: IncidentStatus.NEEDS_REVIEW,
      validationStatus: ValidationStatus.MISMATCH,
      validationEvidence: validation.evidence,
      occurredAt: new Date("2026-01-15T12:00:00.000Z"),
    });

    await prisma.$transaction(async (tx) => {
      await appendAuditLog(tx, {
        workspaceId: workspace.id,
        incidentId: incident.id,
        eventType: AuditEventType.VALIDATION_STARTED,
        actorType: ActorType.SYSTEM,
        metadata: { apiSpecId: apiSpec.id },
      });
      await appendAuditLog(tx, {
        workspaceId: workspace.id,
        incidentId: incident.id,
        eventType: AuditEventType.VALIDATION_COMPLETED,
        actorType: ActorType.SYSTEM,
        metadata: {
          validationStatus: ValidationStatus.MISMATCH,
          evidenceCount: validation.evidence.length,
        },
      });
    });
  }

    console.log("Seed completed (idempotent).");
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
