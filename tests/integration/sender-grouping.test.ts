import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Prisma, type ApiSpec, type SenderBinding as SenderBindingRecord } from "@/generated/prisma/client";
import type { SenderBindingImport } from "@/lib/ingestion/sender-identity";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { importSenderBinding, revokeSenderBinding } from "@/server/services/sender-identity";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import { importHistoricalBinding } from "@/server/services/historical-revisions";
import { submitIncidentWithIngestionToken } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { assignIncidentToInvestigationGroup } from "@/server/services/assign-incident-investigation-group";
import { processEvidencePreparation } from "@/server/services/process-evidence-preparation";
import { groupingWindowForReceivedAt } from "@/lib/investigation/grouping-window";
import { computeFindingSignature } from "@/lib/investigation/finding-signature";
import { senderGroupingIdentity } from "@/lib/investigation/sender-grouping";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? ""))
  throw new Error("Use verify:sender-grouping in its disposable database");
const db = createPrismaClientForUrl(url);
afterEach(() => vi.unstubAllEnvs()); afterAll(() => db.$disconnect());

async function fixture() {
  const w = await db.workspace.create({ data: { name: "Synthetic sender grouping", slug: `sender-group-${randomUUID()}` } });
  const key = await issueIngestionCredential(db, w.id, "Synthetic grouping collector");
  const senders: { input: SenderBindingImport; binding: SenderBindingRecord }[] = [];
  for (const name of ["Sender A", "Sender B"]) {
    const input = { ingestionCredentialId: key.credential.id, apiKey: "payments", environment: "default", principalKind: "api_key_id" as const,
      principalRef: randomUUID(), senderKey: randomUUID(), displayName: name };
    const registered = await importSenderBinding(db, w.id, input); senders.push({ input, binding: registered.binding });
  }
  const revisions: ApiSpec[] = [];
  vi.stubEnv("SPEKTRACE_HISTORICAL_BINDING_ALLOWLIST", JSON.stringify([{ integrationKey: "synthetic-grouping", apiKey: "payments", environment: "default" }]));
  vi.stubEnv("SPEKTRACE_EVIDENCE_PREPARATION_ENABLED", "true");
  for (let index = 0; index < 2; index++) {
    const schema = { type: "object", required: ["amount"], properties: { amount: { type: "integer" }, [`optional_${index}`]: { type: "string" } } };
    const requestBody = { content: { "application/json": { schema } } };
    const document = { openapi: "3.1.0", paths: { "/payments": { post: { requestBody }, put: { requestBody } }, "/refunds": { post: { requestBody } } } };
    const sourceText = JSON.stringify(document);
    const spec = await db.apiSpec.create({ data: { workspaceId: w.id, apiKey: "payments", environment: "default", name: "Synthetic contracts",
      version: `${index + 1}.0.0`, openApiVersion: "3.1.0", sourceFilename: "synthetic.json", sourceText, parsedDocument: document,
      sourceSha256: createHash("sha256").update(sourceText).digest("hex"), isActive: index === 1 } });
    const deploymentId = `revision-${index}`;
    await db.deploymentRecord.create({ data: { workspaceId: w.id, apiKey: "payments", environment: "default", integrationKey: "synthetic-grouping", sourceDeploymentId: deploymentId, apiSpecId: spec.id } });
    await importHistoricalBinding(db, w.id, { integrationKey: "synthetic-grouping", sourceIntervalId: deploymentId, sourceDeploymentId: deploymentId,
      apiKey: "payments", environment: "default", apiSpecId: spec.id, sourceSha256: spec.sourceSha256,
      validFrom: `2025-01-0${index + 1}T00:00:00.000Z`, validUntil: `2025-01-0${index + 2}T00:00:00.000Z` });
    revisions.push(spec);
  }
  async function ingest(sender = 0, revision = 0, extra: Partial<Parameters<typeof submitIncidentWithIngestionToken>[2]> = {}, token = key.token) {
    const input = senders[sender]?.input;
    const result = await submitIncidentWithIngestionToken(db, token, { source: "WEBHOOK", sourceEventId: randomUUID(), apiKey: "payments", environment: "default",
      httpMethod: "POST", requestPath: "/payments", statusCode: 400, occurredAt: `2025-01-0${revision + 1}T00:00:00.000Z`, revisionSelectionMode: "historical",
      senderReference: input ? { principalKind: input.principalKind, principalRef: input.principalRef } : undefined,
      sanitizedRequestBody: { amount: "100" }, ...extra });
    await processIncidentValidation(db, w.id, result.incident.id);
    return db.incident.update({ where: { id: result.incident.id }, data: { receivedAt: new Date("2026-01-01T00:01:00.000Z") } });
  }
  async function group(incidentId: string) {
    const result = await assignIncidentToInvestigationGroup(db, w.id, incidentId);
    expect(result.status).toBe("assigned"); if (result.status !== "assigned") throw new Error("Expected assigned group");
    return db.investigationGroup.findUniqueOrThrow({ where: { id: result.investigationGroupId } });
  }
  return { w, key, senders, revisions, ingest, group };
}

describe("sender and pinned-revision grouping v2", () => {
  it("merges the same sender/revision but separates different senders even for identical findings", async () => {
    const f = await fixture(); const a = await f.ingest(); const b = await f.ingest(); const other = await f.ingest(1);
    expect(a.validationStatus).toBe("MISMATCH"); expect(other.validationEvidence).toMatchObject({ specRevision: { apiSpecId: f.revisions[0].id } });
    const ga = await f.group(a.id); const gb = await f.group(b.id); const gc = await f.group(other.id);
    expect(ga.id).toBe(gb.id); expect(gc.id).not.toBe(ga.id);
    expect(ga).toMatchObject({ groupingVersion: 2, senderId: f.senders[0].binding.senderId, senderGroupingKey: `sender:${f.senders[0].binding.senderId}` });
    expect(gc.senderId).toBe(f.senders[1].binding.senderId);
  });

  it("separates two historical contract revisions for the same sender and same type mismatch", async () => {
    const f = await fixture(); const a = await f.ingest(0, 0); const b = await f.ingest(0, 1);
    const first = await f.group(a.id); const second = await f.group(b.id);
    expect(first.id).not.toBe(second.id); expect(first.senderId).toBe(second.senderId);
    expect(first.apiSpecId).toBe(f.revisions[0].id); expect(second.apiSpecId).toBe(f.revisions[1].id);
    expect(first.findingSignature).toBe(second.findingSignature);
  });

  it("isolates unknown and matching reported-header senders instead of collecting them as one client", async () => {
    const f = await fixture();
    const trusted = await f.ingest(); const unknownA = await f.ingest(-1); const unknownB = await f.ingest(-1);
    const spoofed = await f.ingest(-1, 0, { reportedClientRef: f.senders[0].input.principalRef });
    const groups = await Promise.all([trusted, unknownA, unknownB, spoofed].map((incident) => f.group(incident.id)));
    expect(new Set(groups.map((group) => group.id)).size).toBe(4);
    expect(groups.slice(1).every((group) => group.senderId === null && group.senderGroupingKey.startsWith("unknown:"))).toBe(true);
  });

  it("groups the same canonical sender across explicitly registered collector aliases and keeps old attestations after revocation", async () => {
    const f = await fixture(); const old = await f.ingest();
    const otherKey = await issueIngestionCredential(db, f.w.id, "Explicit replacement collector"); const ref = randomUUID();
    await importSenderBinding(db, f.w.id, { ...f.senders[0].input, ingestionCredentialId: otherKey.credential.id, principalRef: ref });
    await revokeSenderBinding(db, f.w.id, f.senders[0].binding.id);
    const next = await f.ingest(0, 0, { senderReference: { principalKind: "api_key_id", principalRef: ref } }, otherKey.token);
    expect((await f.group(old.id)).id).toBe((await f.group(next.id)).id);
    const untrusted = await f.ingest(); expect((await f.group(untrusted.id)).senderId).toBeNull();
  });

  it("retains method, operation, finding and exact received-window boundaries", async () => {
    const f = await fixture(); const baseline = await f.ingest();
    const method = await f.ingest(0, 0, { httpMethod: "PUT" }); const path = await f.ingest(0, 0, { requestPath: "/refunds" });
    const finding = await f.ingest(0, 0, { sanitizedRequestBody: {} }); const passed = await f.ingest(0, 0, { sanitizedRequestBody: { amount: 100 } });
    const justBefore = await f.ingest(); await db.incident.update({ where: { id: justBefore.id }, data: { receivedAt: new Date("2026-01-01T00:14:59.999Z") } });
    const exactEnd = await f.ingest(); await db.incident.update({ where: { id: exactEnd.id }, data: { receivedAt: new Date("2026-01-01T00:15:00.000Z") } });
    const groups = await Promise.all([baseline, method, path, finding, passed, exactEnd].map((incident) => f.group(incident.id)));
    expect(new Set(groups.map((group) => group.id)).size).toBe(6); expect((await f.group(justBefore.id)).id).toBe(groups[0].id);
  });

  it("treats an invalid or missing revision proof as incident-specific uncertainty", async () => {
    const f = await fixture(); const good = await f.ingest(); const a = await f.ingest(); const b = await f.ingest();
    for (const incident of [a, b]) {
      const evidence = incident.validationEvidence as Prisma.JsonObject;
      await db.incident.update({ where: { id: incident.id }, data: { validationEvidence: { ...evidence,
        specRevision: { apiSpecId: incident.apiSpecId, sourceSha256: "f".repeat(64) } } as Prisma.InputJsonValue } });
    }
    const groups = await Promise.all([good, a, b].map((incident) => f.group(incident.id)));
    expect(new Set(groups.map((group) => group.id)).size).toBe(3);
    for (const group of groups.slice(1)) expect(group).toMatchObject({ apiSpecId: null, pinnedApiSpecKey: expect.stringMatching(/^unknown_revision:/) });
    const missingA = await f.ingest(0, 0, { occurredAt: "2024-01-01T00:00:00.000Z" });
    const missingB = await f.ingest(0, 0, { occurredAt: "2024-01-01T00:00:00.000Z" });
    const unknownA = await f.group(missingA.id); const unknownB = await f.group(missingB.id);
    expect(unknownA.apiSpecId).toBeNull(); expect(unknownB.apiSpecId).toBeNull(); expect(unknownA.id).not.toBe(unknownB.id);
    expect(unknownA.senderId).toBe(f.senders[0].binding.senderId);
  });

  it("does not trust transplanted provenance attached to another canonical sender", async () => {
    const f = await fixture(); const genuine = await f.ingest(); const other = await f.ingest(1);
    const forged = await db.incident.create({ data: { workspaceId: f.w.id, apiKey: "payments", environment: "default", source: "WEBHOOK", sourceEventId: randomUUID(),
      httpMethod: "POST", requestPath: "/payments", statusCode: 400, occurredAt: genuine.occurredAt, receivedAt: genuine.receivedAt,
      apiSpecId: genuine.apiSpecId, validationStatus: genuine.validationStatus, validationEvidence: genuine.validationEvidence as Prisma.InputJsonValue,
      senderId: other.senderId, senderBindingId: other.senderBindingId, collectorCredentialId: other.collectorCredentialId,
      senderClaim: other.senderClaim as Prisma.InputJsonValue, senderProvenance: genuine.senderProvenance as Prisma.InputJsonValue } });
    const grouped = await f.group(forged.id); expect(grouped.senderId).toBeNull();
    expect(grouped.id).not.toBe((await f.group(genuine.id)).id); expect(grouped.id).not.toBe((await f.group(other.id)).id);
  });

  it("isolates minimal, empty-finding and outcome-inconsistent evidence even when revision id/hash match", async () => {
    const f = await fixture(); const groups: string[] = [];
    for (const variant of ["minimal", "empty", "outcome", "scope", "finding"]) {
      for (let index = 0; index < 2; index++) {
        const incident = await f.ingest(); const original = incident.validationEvidence as Prisma.JsonObject;
        const evidence = variant === "minimal" ? { version: 1, specRevision: original.specRevision } :
          variant === "empty" ? { ...original, findings: [] } : variant === "outcome" ? { ...original, outcome: "PASSED" } :
            variant === "finding" ? { ...original, findings: [{ ...(original.findings as Prisma.JsonObject[])[0], expected: { invalid: true } }] } :
            { ...original, scope: { ...(original.scope as Prisma.JsonObject), matchedMethod: "PUT" } };
        await db.incident.update({ where: { id: incident.id }, data: { validationEvidence: evidence as Prisma.InputJsonValue } });
        const group = await f.group(incident.id); expect(group.apiSpecId).toBeNull(); groups.push(group.id);
      }
    }
    expect(new Set(groups).size).toBe(10);
  });

  it("returns an existing v1 membership without creating an orphan v2 group or changing its preparation", async () => {
    const f = await fixture(); const incident = await f.ingest(); const window = groupingWindowForReceivedAt(incident.receivedAt);
    const legacy = await db.investigationGroup.create({ data: { workspaceId: f.w.id, apiKey: "payments", environment: "default", httpMethod: "POST",
      operationIdentity: "/payments", apiSpecId: incident.apiSpecId, pinnedApiSpecKey: incident.apiSpecId!, findingSignature: computeFindingSignature(incident.validationStatus, incident.validationEvidence),
      windowStart: window.start, windowEnd: window.end, membershipVersion: 1 } });
    await db.investigationGroupMembership.create({ data: { workspaceId: f.w.id, investigationGroupId: legacy.id, incidentId: incident.id, incidentReceivedAt: incident.receivedAt } });
    const preparation = await db.evidencePreparationRun.create({ data: { workspaceId: f.w.id, investigationGroupId: legacy.id, runSequence: 1, membershipVersion: 1,
      evidenceFormatVersion: 1, builderVersion: "legacy-fixture", status: "EVIDENCE_READY" } });
    const beforeOutbox = await db.outboxEvent.count({ where: { workspaceId: f.w.id } });
    expect((await f.group(incident.id)).id).toBe(legacy.id);
    expect(await db.investigationGroup.count({ where: { workspaceId: f.w.id } })).toBe(1);
    expect(await db.investigationGroup.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(legacy);
    expect(await db.evidencePreparationRun.findUniqueOrThrow({ where: { id: preparation.id } })).toEqual(preparation);
    expect(await db.outboxEvent.count({ where: { workspaceId: f.w.id } })).toBe(beforeOutbox);
  });

  it("atomically deduplicates concurrent memberships, increments only once per incident and prepares one isolated manifest", async () => {
    const f = await fixture(); const incidents = await Promise.all(Array.from({ length: 3 }, () => f.ingest()));
    const results = await Promise.all(incidents.flatMap((incident) => [f.group(incident.id), f.group(incident.id)]));
    const id = results[0].id; expect(results.every((group) => group.id === id)).toBe(true);
    const group = await db.investigationGroup.findUniqueOrThrow({ where: { id } }); expect(group.membershipVersion).toBe(3);
    expect(await db.investigationGroupMembership.count({ where: { investigationGroupId: id } })).toBe(3);
    expect(await db.outboxEvent.count({ where: { investigationGroupId: id, eventType: "INVESTIGATION_GROUP_PREPARATION_REQUESTED" } })).toBe(1);
    await f.group((await f.ingest(1)).id);
    const prepared = await processEvidencePreparation(db, f.w.id, id); expect(prepared).toMatchObject({ runStatus: "EVIDENCE_READY" });
    const run = await db.evidencePreparationRun.findFirstOrThrow({ where: { investigationGroupId: id }, orderBy: { runSequence: "desc" } });
    const summary = run.protectedSummary as Prisma.JsonObject;
    const included = (summary.includedIncidents as { incidentId: string }[]).map((item) => item.incidentId).sort();
    expect(included).toEqual(incidents.map((incident) => incident.id).sort()); expect(summary.aiInvestigationPerformed).toBe(false);
    for (const forbidden of [f.senders[0].binding.senderId, f.senders[0].input.principalRef, f.key.credential.id]) expect(JSON.stringify(summary)).not.toContain(forbidden);
    expect(await db.investigationInferenceRun.count({ where: { workspaceId: f.w.id } })).toBe(0);
    expect(await db.incident.count({ where: { workspaceId: f.w.id, approvedAt: { not: null } } })).toBe(0);
  });

  it("keeps workspace boundaries and rejects a mismatched canonical key in the database", async () => {
    const f = await fixture(); const other = await fixture();
    const incident = await f.ingest(); const second = await other.ingest();
    const a = await f.group(incident.id); const b = await other.group(second.id); expect(a.id).not.toBe(b.id);
    await expect(db.investigationGroup.update({ where: { id: a.id }, data: { senderGroupingKey: `sender:${randomUUID()}` } })).rejects.toThrow();
    const full = await db.incident.findUniqueOrThrow({ where: { id: incident.id }, include: { senderBinding: { include: { sender: true } } } });
    expect(senderGroupingIdentity(full).senderId).toBe(f.senders[0].binding.senderId);
  });
});
