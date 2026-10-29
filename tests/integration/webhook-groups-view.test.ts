import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { listWebhookGroups, loadWebhookGroup } from "@/server/dashboard/webhook-groups";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? "")) throw new Error("Use disposable group-view verification");
const db = createPrismaClientForUrl(url); afterAll(() => db.$disconnect());
// Stored-record fixtures exercise the read boundary; signed ingestion is verified in the grouping suite and browser preview.
async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Synthetic group-view fixture", slug: `group-view-${randomUUID()}` } });
  const credential = await db.ingestionCredential.create({ data: { id: randomUUID(), workspaceId: workspace.id, name: "Synthetic view collector", tokenSha256: "a".repeat(64), expiresAt: new Date(Date.now() + 86400_000) } });
  const sender = await db.workspaceSender.create({ data: { workspaceId: workspace.id, senderKey: randomUUID(), displayName: "Synthetic partner" } });
  const spec = await db.apiSpec.create({ data: { workspaceId: workspace.id, apiKey: "synthetic-webhook-payments", environment: "default", name: "Synthetic payments", version: "1.0.0",
    sourceFilename: "synthetic.json", sourceText: "{}", parsedDocument: {}, sourceSha256: "a".repeat(64), openApiVersion: "3.1.0" } });
  async function group(offset = 0, service = "synthetic-webhook-payments", environment = "default") {
    const start = new Date(Date.UTC(2026, 9, 23, 0, offset * 15));
    return db.webhookDriftGroup.create({ data: { workspaceId: workspace.id, apiKey: service, environment, httpMethod: "POST", operationPath: "/payments",
      senderId: sender.id, apiSpecId: spec.id, sourceSha256: spec.sourceSha256, driftFingerprint: "b".repeat(64), groupingVersion: 1,
      windowStart: start, windowEnd: new Date(start.getTime() + 900_000) } });
  }
  return { workspace, credential, sender, spec, group };
}
describe("read-only webhook group views", () => {
  it("does not expose another workspace group through the list or a known detail id", async () => {
    const owner = await fixture(); const other = await fixture(); const group = await owner.group();
    expect((await listWebhookGroups(db, other.workspace.id, { page: 1 })).rows).toEqual([]);
    expect(await loadWebhookGroup(db, other.workspace.id, group.id, { page: 1 }, 1)).toBeNull();
  });
  it("paginates groups deterministically and applies service/environment scope", async () => {
    const f = await fixture();
    for (let i = 0; i < 21; i++) await f.group(i);
    await f.group(25, "other-service", "staging");
    const filters = { page: 1, service: "synthetic-webhook-payments", environment: "default" };
    const first = await listWebhookGroups(db, f.workspace.id, filters); const next = await listWebhookGroups(db, f.workspace.id, { ...filters, page: 2 });
    expect(first.total).toBe(21); expect(first.rows).toHaveLength(20); expect(next.rows).toHaveLength(1);
    expect(new Set([...first.rows, ...next.rows].map((row) => row.id)).size).toBe(21);
    expect(first.rows[0].windowStart > first.rows[1].windowStart).toBe(true);
    expect(await loadWebhookGroup(db, f.workspace.id, first.rows[0].id, { ...filters, environment: "staging" }, 1)).toBeNull();
    expect(await loadWebhookGroup(db, f.workspace.id, first.rows[0].id, { ...filters, service: "other-service" }, 1)).toBeNull();
    expect((await listWebhookGroups(db, f.workspace.id, { ...filters, page: 3 })).rows).toEqual([]);
  });
  it("bounds member pages and exports metadata only without writing records", async () => {
    const f = await fixture(); const group = await f.group(); const marker = `unique-private-${randomUUID()}`;
    const ids = Array.from({ length: 21 }, () => randomUUID()).sort();
    await db.webhookReceipt.createMany({ data: ids.map((id) => ({ id, workspaceId: f.workspace.id, collectorCredentialId: f.credential.id, sourceEventId: randomUUID(),
      apiKey: "synthetic-webhook-payments", environment: "default", operationPath: "/payments", apiSpecId: f.spec.id,
      sanitizedPayload: { forbidden: marker }, protection: {}, revisionSelection: {}, validationStatus: "MISMATCH", validationEvidence: { private: marker } })) });
    await db.webhookGroupingDecision.createMany({ data: ids.map((receiptId) => ({ receiptId, workspaceId: f.workspace.id, groupId: group.id, reason: "GROUPED", groupingVersion: 1, createdAt: new Date("2026-10-23T00:01:00Z") })) });
    const before = await db.webhookGroupingDecision.count({ where: { workspaceId: f.workspace.id } });
    const first = await loadWebhookGroup(db, f.workspace.id, group.id, { page: 2 }, 1);
    const second = await loadWebhookGroup(db, f.workspace.id, group.id, { page: 2 }, 2);
    expect(first?.receipts.map((row) => row.id)).toEqual(ids.slice(0, 20)); expect(second?.receipts.map((row) => row.id)).toEqual(ids.slice(20));
    expect(first?.group.count).toBe(21); expect(second?.group.count).toBe(21);
    const output = JSON.stringify([first, second, await listWebhookGroups(db, f.workspace.id, { page: 1 })]);
    expect(output).not.toContain(marker); expect(output).not.toContain("tokenSha256"); expect(output).not.toContain("sanitizedPayload"); expect(output).not.toContain("validationEvidence");
    expect((await loadWebhookGroup(db, f.workspace.id, group.id, { page: 1 }, 3))?.receipts).toEqual([]);
    expect(await db.webhookGroupingDecision.count({ where: { workspaceId: f.workspace.id } })).toBe(before);
    expect(await db.incident.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });
  it("handles malformed ids and member pages without returning group data", async () => {
    const f = await fixture(); const group = await f.group();
    for (const id of ["not-a-uuid", "../../other", randomUUID()]) expect(await loadWebhookGroup(db, f.workspace.id, id, { page: 1 }, 1)).toBeNull();
    for (const page of [0, -1, Infinity, 1.5, 10001]) expect(await loadWebhookGroup(db, f.workspace.id, group.id, { page: 1 }, page)).toBeNull();
  });
});
