import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { IncidentStatus, ValidationStatus } from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { filterIncludesCategory, statusCategory } from "@/lib/dashboard/incident-status";
import { QUEUE_PAGE_SIZE } from "@/lib/dashboard/queue-query";
import {
  getWorkspaceIncidentDetail,
  listWorkspaceIncidents,
} from "@/server/dashboard/incident-review-data";
import { activateApiSpecRevision, registerApiSpec } from "@/server/repositories/api-specs";
import { createIncident } from "@/server/repositories/incidents";
import { resetDatabase } from "./helpers/reset-database";

const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());

async function makeWorkspace(name: string) {
  return prisma.workspace.create({ data: { name, slug: `${name}-${randomUUID()}` } });
}

async function makeIncident(
  workspaceId: string,
  status: IncidentStatus,
  validationStatus: ValidationStatus,
  extra: Partial<Parameters<typeof createIncident>[1]> = {},
) {
  return createIncident(prisma, {
    workspaceId,
    apiKey: "payments-api",
    source: "WEBHOOK",
    sourceEventId: `evt-${randomUUID()}`,
    httpMethod: "POST",
    requestPath: "/payments",
    statusCode: 400,
    occurredAt: new Date(),
    status,
    validationStatus,
    ...extra,
  });
}

const STATE_MATRIX: Array<[IncidentStatus, ValidationStatus]> = [
  ["RECEIVED", "NOT_RUN"],
  ["VALIDATING", "NOT_RUN"],
  ["NEEDS_REVIEW", "MISMATCH"],
  ["NEEDS_REVIEW", "PASSED"],
  ["NEEDS_REVIEW", "UNSUPPORTED"],
  ["NEEDS_REVIEW", "ERROR"],
  ["FAILED", "NOT_RUN"],
];

describe("dashboard incident queries", () => {
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("filters match the central status mapping and stay inside the workspace", async () => {
    const pilot = await makeWorkspace("pilot");
    const other = await makeWorkspace("other");
    for (const [status, validation] of STATE_MATRIX) {
      await makeIncident(pilot.id, status, validation);
      await makeIncident(other.id, status, validation);
    }

    const all = await listWorkspaceIncidents(prisma, pilot.id, "all", 1);
    expect(all.counts.all).toBe(STATE_MATRIX.length);
    expect(all.counts.failed).toBe(2);

    for (const filter of ["pending", "triaged"] as const) {
      const expected = STATE_MATRIX.filter(([s, v]) =>
        filterIncludesCategory(filter, statusCategory(s, v)),
      ).length;
      const page = await listWorkspaceIncidents(prisma, pilot.id, filter, 1);
      expect(page.counts[filter]).toBe(expected);
      expect(page.rows).toHaveLength(expected);
      expect(page.rows.every((row) => filterIncludesCategory(filter, row.category))).toBe(true);
    }

    const otherIds = new Set(
      (await prisma.incident.findMany({ where: { workspaceId: other.id }, select: { id: true } })).map((r) => r.id),
    );
    expect(all.rows.some((row) => otherIds.has(row.id))).toBe(false);
  });

  it("paginates 25 per page and clamps out-of-range pages", async () => {
    const pilot = await makeWorkspace("pilot");
    const base = Date.now();
    for (let i = 0; i < QUEUE_PAGE_SIZE + 3; i += 1) {
      await makeIncident(pilot.id, "NEEDS_REVIEW", "MISMATCH", { receivedAt: new Date(base - i * 1000) });
    }

    const first = await listWorkspaceIncidents(prisma, pilot.id, "all", 1);
    const second = await listWorkspaceIncidents(prisma, pilot.id, "all", 2);
    const beyond = await listWorkspaceIncidents(prisma, pilot.id, "all", 99);

    expect(first.rows).toHaveLength(QUEUE_PAGE_SIZE);
    expect(second.rows).toHaveLength(3);
    expect(first.totalPages).toBe(2);
    expect(beyond.page).toBe(2);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(QUEUE_PAGE_SIZE + 3);
  });

  it("does not return another workspace's incident by ID", async () => {
    const pilot = await makeWorkspace("pilot");
    const other = await makeWorkspace("other");
    const foreign = await makeIncident(other.id, "NEEDS_REVIEW", "MISMATCH");

    expect(await getWorkspaceIncidentDetail(prisma, pilot.id, foreign.id)).toBeNull();
    expect(await getWorkspaceIncidentDetail(prisma, pilot.id, randomUUID())).toBeNull();
    expect(await getWorkspaceIncidentDetail(prisma, other.id, foreign.id)).not.toBeNull();
  });

  it("distinguishes a missing body from JSON null and reads the pinned spec relation", async () => {
    const pilot = await makeWorkspace("pilot");
    const pinned = await registerApiSpec(prisma, {
      workspaceId: pilot.id,
      apiKey: "payments-api",
      name: "Payments",
      version: "1.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "v1.yaml",
      sourceText: "openapi: 3.1.0",
      sourceSha256: "sha-v1",
      parsedDocument: { openapi: "3.1.0" },
    });
    await activateApiSpecRevision(prisma, pilot.id, pinned.id);

    const missing = await makeIncident(pilot.id, "NEEDS_REVIEW", "UNSUPPORTED", { apiSpecId: pinned.id });
    const jsonNull = await makeIncident(pilot.id, "NEEDS_REVIEW", "UNSUPPORTED", { sanitizedRequestBody: null });

    const newer = await registerApiSpec(prisma, {
      workspaceId: pilot.id,
      apiKey: "payments-api",
      name: "Payments",
      version: "2.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "v2.yaml",
      sourceText: "openapi: 3.1.0 # v2",
      sourceSha256: "sha-v2",
      parsedDocument: { openapi: "3.1.0" },
    });
    await activateApiSpecRevision(prisma, pilot.id, newer.id);

    const missingView = await getWorkspaceIncidentDetail(prisma, pilot.id, missing.id);
    const nullView = await getWorkspaceIncidentDetail(prisma, pilot.id, jsonNull.id);

    expect(missingView?.body).toEqual({ kind: "missing" });
    expect(nullView?.body).toEqual({ kind: "json", text: "null", isJsonNull: true });
    expect(missingView?.spec).toMatchObject({
      kind: "pinned",
      id: pinned.id,
      version: "1.0.0",
      isCurrentlyActive: false,
    });
    expect(nullView?.spec.kind).toBe("none");
  });
});
