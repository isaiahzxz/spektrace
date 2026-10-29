import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuditEventType, IncidentSource } from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { SpecActivationError, activateApiSpecRevision } from "@/server/repositories/api-specs";
import { submitIncident } from "@/server/services/incident-submission";
import { importSpecRevision } from "@/server/specs/import-revision";
import { resetDatabase } from "./helpers/reset-database";

const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());
const source = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Core Payments & Checkout API", version: "1.0.0" },
  paths: { "/payments": { post: { responses: { "201": { description: "ok" } } } } },
});

describe("specification import and client attribution", () => {
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps an import inactive, replays it, and refuses an older activation", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Registry", slug: `w-${randomUUID()}` } });
    const first = await importSpecRevision(prisma, workspace.id, {
      apiKey: "payments-api",
      environment: "staging",
      sourceFilename: "payments.json",
      sourceText: source,
      provenance: { repository: "example/payments", commitSha: "abc1234", openApiPath: "spec/payments.json" },
    });
    expect(first.created).toBe(true);
    expect(first.spec.isActive).toBe(false);
    const replay = await importSpecRevision(prisma, workspace.id, {
      apiKey: "payments-api",
      environment: "staging",
      sourceFilename: "payments.json",
      sourceText: source,
    });
    expect(replay.created).toBe(false);
    expect(replay.spec.id).toBe(first.spec.id);
    expect(await prisma.auditLog.count({ where: { workspaceId: workspace.id, eventType: AuditEventType.SPEC_REGISTERED } })).toBe(1);

    const newer = await importSpecRevision(prisma, workspace.id, {
      apiKey: "payments-api",
      environment: "staging",
      sourceFilename: "payments.json",
      sourceText: source.replace("1.0.0", "1.1.0"),
    });
    await activateApiSpecRevision(prisma, workspace.id, newer.spec.id);
    await expect(activateApiSpecRevision(prisma, workspace.id, first.spec.id)).rejects.toBeInstanceOf(SpecActivationError);
    const active = await prisma.apiSpec.findFirst({ where: { id: newer.spec.id } });
    expect(active?.isActive).toBe(true);
    await activateApiSpecRevision(prisma, workspace.id, newer.spec.id);
    expect(await prisma.auditLog.count({ where: { workspaceId: workspace.id, eventType: AuditEventType.SPEC_ACTIVATED } })).toBe(1);
  });

  it("stores partial client metadata and leaves older incidents unknown", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Clients", slug: `w-${randomUUID()}` } });
    const plain = await submitIncident(prisma, workspace.id, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: "plain",
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: "2026-10-19T01:00:00.000Z",
    });
    const tagged = await submitIncident(prisma, workspace.id, {
      source: IncidentSource.WEBHOOK,
      sourceEventId: "tagged",
      apiKey: "payments-api",
      environment: "staging",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: "2026-10-19T02:00:00.000Z",
      client: { applicationName: "Checkout", applicationVersion: "2026.10.1", platform: "iOS" },
    });
    expect(plain.incident.applicationName).toBeNull();
    expect(plain.incident.environment).toBe("default");
    expect(tagged.incident.platform).toBe("iOS");
    expect(tagged.incident.sdkName).toBeNull();
    expect(tagged.incident.apiSpecId).toBeNull();
  });
});
