import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { Prisma, type WebhookReceipt } from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { createSignedSyntheticWebhookApp } from "@/server/webhooks/signed-synthetic-express-app";
import type { SyntheticSigningKey } from "@/server/webhooks/synthetic-signature";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import { importSenderBinding, revokeSenderBinding } from "@/server/services/sender-identity";
import { processWebhookValidation } from "@/server/services/process-webhook-validation";
import { routeWorkerJob } from "@/server/services/route-worker-job";
import { acceptSyntheticWebhook } from "@/server/services/accept-synthetic-webhook";
import { sanitizeSyntheticWebhook } from "@/lib/ingestion/synthetic-webhook";
import { loadWebhookReceipt } from "@/server/dashboard/webhook-receipts";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? "")) throw new Error("Use disposable webhook grouping verification");
const db = createPrismaClientForUrl(url); afterAll(() => db.$disconnect());
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Synthetic drift groups", slug: `drift-${randomUUID()}` } });
  const credential = await issueIngestionCredential(db, workspace.id, "Synthetic drift collector");
  async function spec(version = "1.0.0", rule: Prisma.InputJsonObject = { type: "integer" }) {
    const document = { openapi: "3.1.0", info: { title: "Synthetic payments", version }, paths: { "/payments": { post: { requestBody: { content: { "application/json": {
      schema: { type: "object", required: ["amount"], properties: { amount: rule } },
    } } } } } } }; const source = JSON.stringify(document);
    return db.apiSpec.create({ data: { workspaceId: workspace.id, apiKey: "synthetic-webhook-payments", environment: "default", name: "Synthetic payments",
      version, openApiVersion: "3.1.0", sourceFilename: "synthetic.json", sourceText: source, parsedDocument: document,
      sourceSha256: createHash("sha256").update(source).digest("hex"), isActive: true } });
  }
  const revision = await spec();
  const senderKey = randomUUID();
  async function sender(sameSender = false) {
    const key: SyntheticSigningKey = { keyId: randomUUID(), workspaceId: workspace.id, credentialId: credential.credential.id, principalRef: randomUUID(),
      principalKind: "client_id", secretHex: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    const binding = await importSenderBinding(db, workspace.id, { ingestionCredentialId: key.credentialId, apiKey: "synthetic-webhook-payments", environment: "default",
      principalRef: key.principalRef, principalKind: key.principalKind, senderKey: sameSender ? senderKey : randomUUID(), displayName: "Synthetic partner" });
    return { key, binding: binding.binding };
  }
  const a = await sender(true); const b = await sender(); const same = await sender(true);
  const server = createSignedSyntheticWebhookApp(db, [a.key, b.key, same.key]).listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  const port = address.port;
  async function receipt(payload: unknown = { amount: "100" }, key = a.key, event = randomUUID()) {
    const body = JSON.stringify(payload); const timestamp = String(Math.floor(Date.now() / 1000));
    const prefix = `synthetic-hmac-sha256@1\nPOST\n/synthetic/signed-webhooks/payments\n${key.keyId}\n${workspace.id}\n${key.credentialId}\n${key.principalKind}\n${key.principalRef}\n${event}\n${timestamp}\n`;
    const signature = createHmac("sha256", Buffer.from(key.secretHex, "hex")).update(prefix).update(body).digest("hex");
    const response = await fetch(`http://127.0.0.1:${port}/synthetic/signed-webhooks/payments`, { method: "POST", body,
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json", "x-spek-event-id": event,
        "x-spek-key-id": key.keyId, "x-spek-timestamp": timestamp, "x-spek-signature": `v1=${signature}` } });
    expect([200, 202]).toContain(response.status); const result = await response.json();
    return db.webhookReceipt.findUniqueOrThrow({ where: { id: result.receiptId } });
  }
  return { workspace, credential, revision, spec, sender, a, b, same, receipt, server };
}
const decision = (id: string) => db.webhookGroupingDecision.findUniqueOrThrow({ where: { receiptId: id } });
const validate = (row: WebhookReceipt) => routeWorkerJob(db, { task: "validate-webhook", workspaceId: row.workspaceId, webhookReceiptId: row.id });
// Explicit DB fixtures set receipt-time boundaries or corrupt stored provenance without changing an accepted record.
async function copyReceipt(row: WebhookReceipt, overrides: Partial<Prisma.WebhookReceiptUncheckedCreateInput>) {
  return db.webhookReceipt.create({ data: { id: randomUUID(), workspaceId: row.workspaceId, collectorCredentialId: row.collectorCredentialId, sourceEventId: randomUUID(),
    apiKey: row.apiKey, environment: row.environment, operationPath: row.operationPath, apiSpecId: row.apiSpecId,
    sanitizedPayload: row.sanitizedPayload ?? Prisma.JsonNull, protection: row.protection ?? Prisma.JsonNull,
    revisionSelection: row.revisionSelection ?? Prisma.JsonNull, senderVerification: row.senderVerification ?? Prisma.DbNull, ...overrides } });
}
describe("signed webhook mismatch grouping", () => {
  it("groups independently signed structural mismatches once, includes same sender across bindings and preserves validation on retries", async () => {
    const f = await fixture();
    try {
      const event = randomUUID(); const one = await f.receipt({ amount: "100" }, f.a.key, event);
      const two = await f.receipt({ amount: "200" }, f.same.key);
      await Promise.all([validate(one), validate(two), validate(one)]);
      const [a, b] = await Promise.all([decision(one.id), decision(two.id)]);
      expect(a.reason).toBe("GROUPED"); expect(a.groupId).not.toBeNull(); expect(a.groupId).toBe(b.groupId);
      expect(await db.webhookDriftGroup.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
      const before = await db.webhookReceipt.findUniqueOrThrow({ where: { id: one.id } });
      expect((await f.receipt({ amount: "100" }, f.a.key, event)).id).toBe(one.id);
      await validate(one); expect(await decision(one.id)).toEqual(a);
      expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: one.id } })).validatedAt).toEqual(before.validatedAt);
      const view = await loadWebhookReceipt(db, f.workspace.id, one.id, { page: 1 });
      expect(view?.driftGroup).toMatchObject({ id: a.groupId, count: 2 });
      expect(await db.incident.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.investigationInferenceRun.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { await close(f.server); }
  });
  it("keeps a different verified sender out of an otherwise identical group", async () => {
    const f = await fixture();
    try {
      const one = await f.receipt(); const two = await f.receipt({ amount: "100" }, f.b.key);
      await validate(one); await validate(two);
      const [a, b] = await Promise.all([decision(one.id), decision(two.id)]);
      expect(a.reason).toBe("GROUPED"); expect(b.reason).toBe("GROUPED"); expect(a.groupId, "sender separation").not.toBe(b.groupId);
      expect((await loadWebhookReceipt(db, f.workspace.id, one.id, { page: 1 }))?.driftGroup?.count).toBe(1);
    } finally { await close(f.server); }
  });
  it("pins revision identity despite activation changes and distinguishes missing, null and string drift", async () => {
    const f = await fixture();
    try {
      const old = await f.receipt(); await db.apiSpec.update({ where: { id: f.revision.id }, data: { isActive: false } });
      const next = await f.spec("2.0.0"); const newer = await f.receipt(); const missing = await f.receipt({}); const nil = await f.receipt({ amount: null });
      for (const row of [old, newer, missing, nil]) await validate(row);
      const decisions = await Promise.all([old, newer, missing, nil].map((row) => decision(row.id)));
      expect(decisions.every((item) => item.reason === "GROUPED")).toBe(true);
      expect(new Set(decisions.map((item) => item.groupId)).size).toBe(4);
      const groups = await db.webhookDriftGroup.findMany({ where: { workspaceId: f.workspace.id } });
      expect(groups.find((group) => group.id === decisions[0].groupId)?.apiSpecId).toBe(f.revision.id);
      expect(groups.find((group) => group.id === decisions[1].groupId)?.apiSpecId).toBe(next.id);
    } finally { await close(f.server); }
  });
  it("uses inclusive start and exclusive end receipt-time windows independent of delayed validation", async () => {
    const f = await fixture();
    try {
      const original = await f.receipt(); const base = new Date("2026-10-22T01:00:00Z");
      const rows = await Promise.all([0, 899_999, 900_000].map((offset) => copyReceipt(original, { receivedAt: new Date(base.getTime() + offset) })));
      for (const row of rows) await validate(row);
      const groups = await Promise.all(rows.map((row) => decision(row.id)));
      expect(groups[0].reason).toBe("GROUPED"); expect(groups[0].groupId).toBe(groups[1].groupId); expect(groups[0].groupId).not.toBe(groups[2].groupId);
      const group = await db.webhookDriftGroup.findUniqueOrThrow({ where: { id: groups[0].groupId! } });
      expect(group.windowStart).toEqual(base); expect(group.windowEnd).toEqual(new Date(base.getTime() + 900_000));
    } finally { await close(f.server); }
  });
  it("records exclusions for passed, incomplete, unsigned, unsupported and missing-revision receipts", async () => {
    const f = await fixture();
    try {
      const passed = await f.receipt({ amount: 100 }); const incomplete = await f.receipt({ amount: "100", email: "synthetic-private@example.test" });
      const unsignedId = await acceptSyntheticWebhook(db, f.credential.token, randomUUID(), sanitizeSyntheticWebhook({ amount: "100" }));
      const unsigned = await db.webhookReceipt.findUniqueOrThrow({ where: { id: unsignedId.id } });
      for (const row of [passed, incomplete, unsigned]) await validate(row);
      expect((await decision(passed.id)).reason).toBe("NOT_A_MISMATCH"); expect((await decision(incomplete.id)).reason).toBe("NOT_A_MISMATCH");
      expect((await decision(unsigned.id)).reason).toBe("SENDER_UNVERIFIED");
      await db.apiSpec.update({ where: { id: f.revision.id }, data: { isActive: false } });
      const unsupportedSpec = await f.spec("3.0.0", { type: "integer", minimum: 500 }); const below = await f.receipt({ amount: 100 }); await validate(below);
      expect((await decision(below.id)).reason).toBe("EVIDENCE_UNSUPPORTED");
      await db.apiSpec.update({ where: { id: unsupportedSpec.id }, data: { isActive: false } });
      const noPin = await f.receipt(); await validate(noPin); expect((await decision(noPin.id)).reason).toBe("NOT_A_MISMATCH");
      expect(await db.webhookDriftGroup.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { await close(f.server); }
  });
  it("uses acceptance-time verified identity after revocation and refuses corrupt or cross-scope provenance", async () => {
    const f = await fixture(); const other = await fixture();
    try {
      const original = await f.receipt(); await revokeSenderBinding(db, f.workspace.id, f.a.binding.id); await validate(original);
      expect((await decision(original.id)).reason).toBe("GROUPED");
      const corrupt = await copyReceipt(original, { senderVerification: { protocol: "unknown" } }); await validate(corrupt);
      expect((await decision(corrupt.id)).reason).toBe("SENDER_PROVENANCE_INVALID");
      const cross = await copyReceipt(original, { senderVerification: (await other.receipt()).senderVerification ?? Prisma.DbNull }); await validate(cross);
      expect((await decision(cross.id)).reason).toBe("SENDER_PROVENANCE_INVALID");
      const outside = await copyReceipt(original, { environment: "staging" }); await validate(outside);
      expect((await decision(outside.id)).reason).toBe("NOT_A_MISMATCH");
      expect(await loadWebhookReceipt(db, other.workspace.id, original.id, { page: 1 })).toBeNull();
      expect(await loadWebhookReceipt(db, f.workspace.id, original.id, { page: 1, environment: "staging" })).toBeNull();
    } finally { await close(f.server); await close(other.server); }
  });
  it("keeps workspaces isolated and enforces composite foreign keys and immutable decisions", async () => {
    const f = await fixture(); const other = await fixture();
    try {
      const one = await f.receipt(); const two = await other.receipt(); await validate(one); await validate(two);
      const a = await decision(one.id); const b = await decision(two.id); expect(a.groupId).not.toBe(b.groupId);
      const newReceipt = await f.receipt();
      await expect(db.webhookGroupingDecision.create({ data: { receiptId: newReceipt.id, workspaceId: f.workspace.id, groupId: b.groupId, reason: "GROUPED", groupingVersion: 1 } })).rejects.toThrow();
      await expect(db.webhookGroupingDecision.create({ data: { receiptId: newReceipt.id, workspaceId: other.workspace.id, reason: "NOT_A_MISMATCH", groupingVersion: 1 } })).rejects.toThrow();
      await expect(db.webhookGroupingDecision.create({ data: { receiptId: newReceipt.id, workspaceId: f.workspace.id, reason: "GROUPED", groupingVersion: 1 } })).rejects.toThrow();
      await expect(db.webhookGroupingDecision.update({ where: { receiptId: one.id }, data: { groupId: null, reason: "NOT_A_MISMATCH" } })).rejects.toThrow();
      await expect(db.webhookDriftGroup.update({ where: { id: a.groupId! }, data: { senderId: f.b.binding.senderId } })).rejects.toThrow();
      expect((await loadWebhookReceipt(db, f.workspace.id, one.id, { page: 1 }))?.driftGroup?.count).toBe(1);
    } finally { await close(f.server); await close(other.server); }
  });
  it("rolls validation and grouping back on a decision-write failure then recovers once", async () => {
    const f = await fixture(); const row = await f.receipt();
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_webhook_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${f.workspace.id}'::uuid THEN RAISE EXCEPTION 'synthetic decision failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe("CREATE TRIGGER fail_webhook_decision BEFORE INSERT ON webhook_grouping_decisions FOR EACH ROW EXECUTE FUNCTION fail_webhook_decision()");
    try {
      await expect(validate(row)).rejects.toThrow();
      expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: row.id } })).validationStatus).toBe("NOT_RUN");
      expect(await db.webhookDriftGroup.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.webhookGroupingDecision.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { await db.$executeRawUnsafe("DROP TRIGGER fail_webhook_decision ON webhook_grouping_decisions"); await db.$executeRawUnsafe("DROP FUNCTION fail_webhook_decision()"); }
    try {
      await validate(row); await validate(row); expect((await decision(row.id)).reason).toBe("GROUPED");
      expect(await db.webhookGroupingDecision.count({ where: { receiptId: row.id } })).toBe(1);
    } finally { await close(f.server); }
  });
  it("does not silently backfill older completed receipts or create groups during reads", async () => {
    const f = await fixture();
    try {
      const original = await f.receipt(); await validate(original);
      const checked = await db.webhookReceipt.findUniqueOrThrow({ where: { id: original.id } });
      const older = await copyReceipt(checked, { validationStatus: checked.validationStatus, validationEvidence: checked.validationEvidence ?? Prisma.JsonNull, validatedAt: checked.validatedAt });
      expect(await processWebhookValidation(db, f.workspace.id, older.id)).toMatchObject({ reason: "already_completed" });
      const view = await loadWebhookReceipt(db, f.workspace.id, older.id, { page: 1 });
      expect(view?.groupingLabel).toBe("Not evaluated by this grouping version"); expect(view?.driftGroup).toBeNull();
      expect(await db.webhookGroupingDecision.count({ where: { receiptId: older.id } })).toBe(0);
    } finally { await close(f.server); }
  });
  it("refuses deletion of grouping decisions and even empty groups", async () => {
    const f = await fixture();
    try {
      const row = await f.receipt(); await validate(row); const member = await decision(row.id);
      const group = await db.webhookDriftGroup.findUniqueOrThrow({ where: { id: member.groupId! } });
      const empty = await db.webhookDriftGroup.create({ data: { ...group, id: randomUUID(), driftFingerprint: "0".repeat(64) } });
      await expect(db.webhookGroupingDecision.delete({ where: { receiptId: row.id } })).rejects.toThrow("Webhook grouping records are immutable");
      await expect(db.webhookDriftGroup.delete({ where: { id: empty.id } })).rejects.toThrow("Webhook grouping records are immutable");
      expect((await loadWebhookReceipt(db, f.workspace.id, row.id, { page: 1 }))?.driftGroup?.count).toBe(1);
    } finally { await close(f.server); }
  });
});
