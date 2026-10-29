import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { activateApiSpecRevision, registerApiSpec } from "@/server/repositories/api-specs";
import { acceptTestedCorrection, applyAcceptance, evaluateCandidate } from "@/server/review/correction";
import { submitIncident } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";

const db = createPrismaClientForUrl(requireTestDatabaseUrl());
const candidateText = '{\n  "amount": 100\n}';
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let baseline: { incidents: string[]; specs: string[]; audits: string[]; outbox: string[]; digest: string };
let oldAi: string | undefined;

async function originalRecords(ids?: Omit<typeof baseline, "digest">) {
  return {
    incidents: await db.incident.findMany({ where: ids ? { id: { in: ids.incidents } } : {}, orderBy: { id: "asc" } }),
    specs: await db.apiSpec.findMany({ where: ids ? { id: { in: ids.specs } } : {}, orderBy: { id: "asc" } }),
    audits: await db.auditLog.findMany({ where: ids ? { id: { in: ids.audits } } : {}, orderBy: { id: "asc" } }),
    outbox: await db.outboxEvent.findMany({ where: ids ? { id: { in: ids.outbox } } : {}, orderBy: { id: "asc" } }),
  };
}
beforeAll(async () => {
  oldAi = process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED;
  process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = "false";
  const before = await originalRecords();
  baseline = { incidents: before.incidents.map(r => r.id), specs: before.specs.map(r => r.id), audits: before.audits.map(r => r.id), outbox: before.outbox.map(r => r.id), digest: hash(before) };
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try { expect(hash(await originalRecords(baseline))).toBe(baseline.digest); }
  finally {
    if (oldAi === undefined) delete process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED;
    else process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = oldAi;
    await db.$disconnect();
  }
});

async function addSpec(workspaceId: string, options: { environment?: string; apiKey?: string; currency?: boolean; version?: string; supported?: boolean } = {}) {
  const document = { openapi: options.supported === false ? "3.0.3" : "3.1.0", paths: { "/payments": { post: { requestBody: { content: { "application/json": { schema: { type: "object", required: options.currency ? ["amount", "currency"] : ["amount"], properties: { amount: { type: "integer" }, currency: { type: "string" } } } } } } } } } };
  const sourceText = JSON.stringify(document);
  const spec = await registerApiSpec(db, { workspaceId, apiKey: options.apiKey ?? "payments-api", environment: options.environment ?? "default", name: "Synthetic approval payments", version: options.version ?? "1.0.0", openApiVersion: document.openapi, sourceFilename: "synthetic-approval.json", sourceText, sourceSha256: createHash("sha256").update(sourceText).digest("hex"), parsedDocument: document });
  await activateApiSpecRevision(db, workspaceId, spec.id);
  return spec;
}
async function fixture(options: { currency?: boolean; supported?: boolean; redacted?: boolean } = {}) {
  const workspace = await db.workspace.create({ data: { name: "Synthetic approval checkpoint", slug: `approval-check-${randomUUID()}` } });
  const spec = await addSpec(workspace.id, options);
  const submitted = await submitIncident(db, workspace.id, { source: "WEBHOOK", sourceEventId: randomUUID(), apiKey: "payments-api", environment: "default", httpMethod: "POST", requestPath: "/payments", statusCode: 400, occurredAt: new Date().toISOString(), sanitizedRequestBody: { amount: "100", ...(options.currency ? { currency: "USD" } : {}), ...(options.redacted ? { api_key: "synthetic-secret-not-for-export" } : {}) } });
  await processIncidentValidation(db, workspace.id, submitted.incident.id);
  return { workspaceId: workspace.id, incidentId: submitted.incident.id, spec };
}
function input(incidentId: string, text = candidateText, revision: "pinned" | "active" = "pinned") { return { incidentId, candidateText: text, revision }; }
async function snapshot(incidentId: string) { return db.incident.findUniqueOrThrow({ where: { id: incidentId } }); }
async function approvalCount(incidentId: string) { return db.auditLog.count({ where: { incidentId, eventType: "INCIDENT_APPROVED" } }); }

describe("non-reset synthetic correction approval checkpoint", () => {
  it("never validates or approves a default incident against a newer staging contract", async () => {
    const f = await fixture({ currency: true });
    await addSpec(f.workspaceId, { environment: "staging" });
    const before = await snapshot(f.incidentId);
    const checked = await evaluateCandidate(db, f.workspaceId, input(f.incidentId, candidateText, "active"));
    expect(checked.eligible).toBe(false);
    const accepted = await acceptTestedCorrection(db, f.workspaceId, input(f.incidentId, candidateText, "active"));
    expect(accepted.ok).toBe(false);
    expect(hash(await snapshot(f.incidentId))).toBe(hash(before));
    expect(await approvalCount(f.incidentId)).toBe(0);
  });

  it.each([{ environment: "staging" }, { apiKey: "different-service" }])("refuses a pinned revision outside the incident's service/environment scope", async options => {
    const f = await fixture({ currency: true });
    const wrong = await addSpec(f.workspaceId, options);
    await db.incident.update({ where: { id: f.incidentId }, data: { apiSpecId: wrong.id } });
    const before = await snapshot(f.incidentId);
    expect((await acceptTestedCorrection(db, f.workspaceId, input(f.incidentId))).ok).toBe(false);
    expect(hash(await snapshot(f.incidentId))).toBe(hash(before));
    expect(await approvalCount(f.incidentId)).toBe(0);
  });

  it("accepts concurrent and repeated clicks once, preserving original evidence and outbox", async () => {
    const f = await fixture();
    const before = await snapshot(f.incidentId);
    const beforeOutbox = await db.outboxEvent.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { id: "asc" } });
    const beforeSpec = await db.apiSpec.findUniqueOrThrow({ where: { id: f.spec.id } });
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound request"));
    expect((await evaluateCandidate(db, f.workspaceId, input(f.incidentId))).eligible).toBe(true);
    const accepted = await Promise.all([
      acceptTestedCorrection(db, f.workspaceId, input(f.incidentId)),
      acceptTestedCorrection(db, f.workspaceId, input(f.incidentId)),
    ]);
    expect(accepted.map(result => result.ok)).toEqual([true, true]);
    expect((await acceptTestedCorrection(db, f.workspaceId, input(f.incidentId))).ok).toBe(true);
    expect((await acceptTestedCorrection(db, f.workspaceId, input(f.incidentId, '{"amount":200}'))).ok).toBe(false);
    const after = await snapshot(f.incidentId);
    expect(after.status).toBe("APPROVED");
    expect(after.approvedBy).toBe("local-pilot"); expect(after.approvedAt).not.toBeNull();
    expect(after.sanitizedRequestBody).toEqual(before.sanitizedRequestBody);
    expect(after.validationEvidence).toEqual(before.validationEvidence);
    expect(after.validationStatus).toBe(before.validationStatus);
    expect(after.apiSpecId).toBe(before.apiSpecId); expect(after.sentAt).toBeNull();
    const audits = await db.auditLog.findMany({ where: { incidentId: f.incidentId, eventType: "INCIDENT_APPROVED" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ workspaceId: f.workspaceId, actorType: "HUMAN", actorId: "local-pilot" });
    expect(audits[0]!.metadata).toMatchObject({ kind: "tested-correction", specId: f.spec.id, candidateSha256: createHash("sha256").update(candidateText).digest("hex") });
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain('"amount"');
    expect(hash(await db.outboxEvent.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { id: "asc" } }))).toBe(hash(beforeOutbox));
    expect(hash(await db.apiSpec.findUniqueOrThrow({ where: { id: f.spec.id } }))).toBe(hash(beforeSpec));
    expect(outbound).not.toHaveBeenCalled();
  });

  it("revalidates edited JSON instead of trusting an earlier passing test", async () => {
    const f = await fixture(); const before = await snapshot(f.incidentId);
    expect((await evaluateCandidate(db, f.workspaceId, input(f.incidentId))).eligible).toBe(true);
    expect((await acceptTestedCorrection(db, f.workspaceId, input(f.incidentId, '{"amount":"still-text"}'))).ok).toBe(false);
    expect((await acceptTestedCorrection(db, f.workspaceId, input(f.incidentId, '{"amount":'))).ok).toBe(false);
    expect(hash(await snapshot(f.incidentId))).toBe(hash(before));
    expect(await approvalCount(f.incidentId)).toBe(0);
  });

  it("uses the currently selected active contract while preserving the pinned option", async () => {
    const f = await fixture();
    expect((await evaluateCandidate(db, f.workspaceId, input(f.incidentId, candidateText, "active"))).eligible).toBe(true);
    await addSpec(f.workspaceId, { currency: true, version: "2.0.0" });
    expect((await acceptTestedCorrection(db, f.workspaceId, input(f.incidentId, candidateText, "active"))).ok).toBe(false);
    expect(await approvalCount(f.incidentId)).toBe(0);
    expect((await acceptTestedCorrection(db, f.workspaceId, input(f.incidentId))).ok).toBe(true);
    expect((await snapshot(f.incidentId)).apiSpecId).toBe(f.spec.id);
  });

  it("refuses another workspace without changing the original incident", async () => {
    const f = await fixture(); const other = await fixture(); const before = await snapshot(f.incidentId);
    expect((await acceptTestedCorrection(db, other.workspaceId, input(f.incidentId))).ok).toBe(false);
    expect(hash(await snapshot(f.incidentId))).toBe(hash(before)); expect(await approvalCount(f.incidentId)).toBe(0);
  });

  it.each([{ redacted: true }, { supported: false }])("refuses protected or unsupported evidence", async options => {
    const f = await fixture(options); const before = await snapshot(f.incidentId);
    expect((await acceptTestedCorrection(db, f.workspaceId, input(f.incidentId))).ok).toBe(false);
    expect(hash(await snapshot(f.incidentId))).toBe(hash(before)); expect(await approvalCount(f.incidentId)).toBe(0);
  });

  it("rolls the approval and its audit event back atomically", async () => {
    const f = await fixture(); const before = await snapshot(f.incidentId);
    await expect(db.$transaction(async tx => {
      expect((await applyAcceptance(tx, f.workspaceId, input(f.incidentId))).ok).toBe(true);
      throw new Error("Synthetic transaction rollback");
    })).rejects.toThrow("Synthetic transaction rollback");
    expect(hash(await snapshot(f.incidentId))).toBe(hash(before)); expect(await approvalCount(f.incidentId)).toBe(0);
  });
});
