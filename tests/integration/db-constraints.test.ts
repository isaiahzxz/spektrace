import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ActorType,
  AuditEventType,
  IncidentSource,
} from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import {
  activateApiSpecRevision,
  registerApiSpec,
} from "@/server/repositories/api-specs";
import { createIncident } from "@/server/repositories/incidents";
import { resetDatabase } from "./helpers/reset-database";
import { expectSqlFailure } from "./helpers/sql";

const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());

describe("database tenant and integrity constraints", () => {
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects duplicate ingestion keys within a workspace", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "W1", slug: `w-${randomUUID()}` },
    });

    await createIncident(prisma, {
      workspaceId: workspace.id,
      apiKey: "test-api",
      source: IncidentSource.WEBHOOK,
      sourceEventId: "evt-1",
      httpMethod: "GET",
      requestPath: "/x",
      statusCode: 404,
      occurredAt: new Date(),
    });

    await expect(
      createIncident(prisma, {
        workspaceId: workspace.id,
        apiKey: "test-api",
        source: IncidentSource.WEBHOOK,
        sourceEventId: "evt-1",
        httpMethod: "GET",
        requestPath: "/x",
        statusCode: 404,
        occurredAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("allows the same ingestion key in separate workspaces", async () => {
    const w1 = await prisma.workspace.create({
      data: { name: "W1", slug: `w1-${randomUUID()}` },
    });
    const w2 = await prisma.workspace.create({
      data: { name: "W2", slug: `w2-${randomUUID()}` },
    });

    await createIncident(prisma, {
      workspaceId: w1.id,
      apiKey: "test-api",
      source: IncidentSource.WEBHOOK,
      sourceEventId: "shared-key",
      httpMethod: "GET",
      requestPath: "/a",
      statusCode: 404,
      occurredAt: new Date(),
    });

    const second = await createIncident(prisma, {
      workspaceId: w2.id,
      apiKey: "test-api",
      source: IncidentSource.WEBHOOK,
      sourceEventId: "shared-key",
      httpMethod: "GET",
      requestPath: "/b",
      statusCode: 400,
      occurredAt: new Date(),
    });

    expect(second.sourceEventId).toBe("shared-key");
  });

  it("rejects cross-workspace incident to api spec references", async () => {
    const w1 = await prisma.workspace.create({
      data: { name: "W1", slug: `w1-${randomUUID()}` },
    });
    const w2 = await prisma.workspace.create({
      data: { name: "W2", slug: `w2-${randomUUID()}` },
    });

    const spec = await registerApiSpec(prisma, {
      workspaceId: w1.id,
      apiKey: "api",
      name: "API",
      version: "1",
      openApiVersion: "3.1.0",
      sourceFilename: "a.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: "abc",
      parsedDocument: { openapi: "3.1.0" },
    });

    await expect(
      createIncident(prisma, {
        workspaceId: w2.id,
        apiKey: "api",
        apiSpecId: spec.id,
        source: IncidentSource.SENTRY,
        sourceEventId: "evt-x",
        httpMethod: "POST",
        requestPath: "/p",
        statusCode: 400,
        occurredAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("rejects cross-workspace audit log incident references", async () => {
    const w1 = await prisma.workspace.create({
      data: { name: "W1", slug: `w1-${randomUUID()}` },
    });
    const w2 = await prisma.workspace.create({
      data: { name: "W2", slug: `w2-${randomUUID()}` },
    });

    const incident = await createIncident(prisma, {
      workspaceId: w1.id,
      apiKey: "test-api",
      source: IncidentSource.DATADOG,
      sourceEventId: "dd-1",
      httpMethod: "GET",
      requestPath: "/r",
      statusCode: 401,
      occurredAt: new Date(),
    });

    await expect(
      appendAuditLog(prisma, {
        workspaceId: w2.id,
        incidentId: incident.id,
        eventType: AuditEventType.VALIDATION_STARTED,
        actorType: ActorType.SYSTEM,
        metadata: { note: "cross-tenant attempt" },
      }),
    ).rejects.toThrow();
  });

  it("rejects non-4xx status codes", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "W1", slug: `w-${randomUUID()}` },
    });

    await expect(
      prisma.incident.create({
        data: {
          workspaceId: workspace.id,
          apiKey: "test-api",
          source: IncidentSource.WEBHOOK,
          sourceEventId: "bad-status",
          httpMethod: "GET",
          requestPath: "/x",
          statusCode: 500,
          occurredAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects multiple active revisions for the same workspace API key", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "W1", slug: `w-${randomUUID()}` },
    });

    const v1 = await registerApiSpec(prisma, {
      workspaceId: workspace.id,
      apiKey: "payments",
      name: "Payments",
      version: "1.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "p.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: "sha1",
      parsedDocument: { openapi: "3.1.0" },
    });
    const v2 = await registerApiSpec(prisma, {
      workspaceId: workspace.id,
      apiKey: "payments",
      name: "Payments",
      version: "2.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "p.yaml",
      sourceText: "openapi: 3.1.0\ninfo:\n  version: 2",
      sourceSha256: "sha2",
      parsedDocument: { openapi: "3.1.0", info: { version: "2" } },
    });

    await activateApiSpecRevision(prisma, workspace.id, v1.id);
    await activateApiSpecRevision(prisma, workspace.id, v2.id);

    await expect(
      prisma.apiSpec.update({
        where: { id: v1.id },
        data: { isActive: true },
      }),
    ).rejects.toThrow();
  });

  it("allows active specs for different API keys in one workspace", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "W1", slug: `w-${randomUUID()}` },
    });

    const payments = await registerApiSpec(prisma, {
      workspaceId: workspace.id,
      apiKey: "payments",
      name: "Payments",
      version: "1.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "p.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: "sha-p",
      parsedDocument: { openapi: "3.1.0" },
    });
    const users = await registerApiSpec(prisma, {
      workspaceId: workspace.id,
      apiKey: "users",
      name: "Users",
      version: "1.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "u.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: "sha-u",
      parsedDocument: { openapi: "3.1.0" },
    });

    await activateApiSpecRevision(prisma, workspace.id, payments.id);
    await activateApiSpecRevision(prisma, workspace.id, users.id);

    const active = await prisma.apiSpec.findMany({
      where: { workspaceId: workspace.id, isActive: true },
    });
    expect(active).toHaveLength(2);
  });

  it("preserves incident revision reference when a newer revision is activated", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "W1", slug: `w-${randomUUID()}` },
    });

    const v1 = await registerApiSpec(prisma, {
      workspaceId: workspace.id,
      apiKey: "payments",
      name: "Payments",
      version: "1.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "p.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: "sha1",
      parsedDocument: { openapi: "3.1.0" },
    });
    await activateApiSpecRevision(prisma, workspace.id, v1.id);

    const incident = await createIncident(prisma, {
      workspaceId: workspace.id,
      apiKey: "payments",
      apiSpecId: v1.id,
      source: IncidentSource.WEBHOOK,
      sourceEventId: "pinned-revision",
      httpMethod: "POST",
      requestPath: "/pay",
      statusCode: 400,
      occurredAt: new Date(),
    });

    const v2 = await registerApiSpec(prisma, {
      workspaceId: workspace.id,
      apiKey: "payments",
      name: "Payments",
      version: "2.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "p.yaml",
      sourceText: "openapi: 3.1.0\ninfo:\n  version: 2",
      sourceSha256: "sha2",
      parsedDocument: { openapi: "3.1.0", info: { version: "2" } },
    });
    await activateApiSpecRevision(prisma, workspace.id, v2.id);

    const reloaded = await prisma.incident.findUnique({ where: { id: incident.id } });
    expect(reloaded?.apiSpecId).toBe(v1.id);

    const active = await prisma.apiSpec.findFirst({
      where: { workspaceId: workspace.id, apiKey: "payments", isActive: true },
    });
    expect(active?.id).toBe(v2.id);
  });

  it("blocks immutable spec content changes but allows activation toggles", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "W1", slug: `w-${randomUUID()}` },
    });

    const spec = await registerApiSpec(prisma, {
      workspaceId: workspace.id,
      apiKey: "payments",
      name: "Payments",
      version: "1.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "p.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: "sha1",
      parsedDocument: { openapi: "3.1.0" },
    });

    await expect(
      prisma.apiSpec.update({
        where: { id: spec.id },
        data: { sourceText: "tampered" },
      }),
    ).rejects.toThrow();

    const activated = await activateApiSpecRevision(prisma, workspace.id, spec.id);
    expect(activated.isActive).toBe(true);
  });

  it("blocks audit UPDATE, DELETE, and TRUNCATE", async () => {
    const workspace = await prisma.workspace.create({
      data: { name: "W1", slug: `w-${randomUUID()}` },
    });

    const row = await appendAuditLog(prisma, {
      workspaceId: workspace.id,
      eventType: AuditEventType.SPEC_REGISTERED,
      actorType: ActorType.SYSTEM,
      metadata: { ok: true },
    });

    await expectSqlFailure(prisma, (client) =>
      client.$executeRawUnsafe(
        `UPDATE audit_logs SET metadata = '{"tamper":true}'::jsonb WHERE id = $1::uuid`,
        row.id,
      ),
    );

    await expectSqlFailure(prisma, (client) =>
      client.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = $1::uuid`, row.id),
    );

    await expectSqlFailure(prisma, (client) =>
      client.$executeRawUnsafe(`TRUNCATE audit_logs`),
    );

    const stillThere = await prisma.auditLog.findUnique({ where: { id: row.id } });
    expect(stillThere).not.toBeNull();
  });

  it("rolls back state and audit rows when an audited transaction fails", async () => {
    const w1 = await prisma.workspace.create({
      data: { name: "W1", slug: `w1-${randomUUID()}` },
    });
    const w2 = await prisma.workspace.create({
      data: { name: "W2", slug: `w2-${randomUUID()}` },
    });

    const eventId = `rollback-${randomUUID()}`;

    await expect(
      prisma.$transaction(async (tx) => {
        const incident = await tx.incident.create({
          data: {
            workspaceId: w1.id,
            apiKey: "test-api",
            source: IncidentSource.WEBHOOK,
            sourceEventId: eventId,
            httpMethod: "GET",
            requestPath: "/rollback",
            statusCode: 404,
            occurredAt: new Date(),
          },
        });

        await appendAuditLog(tx, {
          workspaceId: w2.id,
          incidentId: incident.id,
          eventType: AuditEventType.INCIDENT_RECEIVED,
          actorType: ActorType.SYSTEM,
          metadata: { attempt: "cross-tenant audit" },
        });
      }),
    ).rejects.toThrow();

    const incidents = await prisma.incident.count({
      where: { sourceEventId: eventId },
    });
    expect(incidents).toBe(0);

    const audits = await prisma.auditLog.count({
      where: {
        eventType: AuditEventType.INCIDENT_RECEIVED,
        metadata: { equals: { attempt: "cross-tenant audit" } },
      },
    });
    expect(audits).toBe(0);
  });
});
