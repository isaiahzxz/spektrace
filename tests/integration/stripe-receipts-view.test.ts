import { createElement } from "react";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import { createStripeTestExpressApp } from "@/server/webhooks/stripe-test-express-app";
import { processStripeWebhookValidation } from "@/server/services/process-stripe-webhook-validation";
import { listStripeReceipts, loadStripeReceipt } from "@/server/dashboard/stripe-receipts";
import { StripeReceiptInspection } from "@/components/dashboard/stripe-receipt-view";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? "")) throw new Error("Use disposable Stripe-view verification");
const db = createPrismaClientForUrl(url);
afterAll(() => db.$disconnect());
async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Stripe view fixture", slug: `stripe-view-${randomUUID()}` } });
  const key = await issueIngestionCredential(db, workspace.id, "Stripe read-only review");
  const integration = await db.stripeWebhookIntegration.create({ data: { workspaceId: workspace.id, ingestionCredentialId: key.credential.id } });
  const secret = { id: randomUUID(), value: `whsec_${randomUUID().replaceAll("-", "")}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  async function accept(type = "payment_intent.payment_failed", extra: Record<string, unknown> = {}) {
    const server = createStripeTestExpressApp(db, { workspaceId: workspace.id, integrationId: integration.id, mode: "test", secrets: [secret] }, key.token).listen(0, "127.0.0.1");
    await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture address");
    try {
      const timestamp = Math.floor(Date.now() / 1000), body = JSON.stringify({ id: `evt_${randomUUID().replaceAll("-", "")}`, object: "event", type,
        created: timestamp - 60, livemode: false, api_version: "2026-09-30.clover", data: { object: { object: "payment_intent", amount: "private-value-not-for-view", currency: "private-currency", ...extra } } });
      const digest = createHmac("sha256", secret.value).update(`${timestamp}.${body}`).digest("hex");
      const response = await fetch(`http://127.0.0.1:${address.port}/stripe/test/webhooks`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${digest}` }, body });
      expect(response.status).toBe(202); return (await response.json()).receiptId as string;
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  return { workspace, key, integration, secret, accept };
}
describe("read-only Stripe receipt view", () => {
  it("shows real pending, incomplete and failed receipts without treating succeeded events as passing checks", async () => {
    const f = await fixture(), pending = await f.accept(), incomplete = await f.accept("payment_intent.succeeded"), failed = await f.accept();
    await processStripeWebhookValidation(db, f.workspace.id, incomplete);
    await db.outboxEvent.updateMany({ where: { stripeWebhookReceiptId: failed }, data: { dispatchStatus: "FAILED", lastError: "never-render-private-job-diagnostics" } });
    const before = JSON.stringify({ receipts: await db.stripeWebhookReceipt.findMany({ where: { workspaceId: f.workspace.id } }), jobs: await db.outboxEvent.findMany({ where: { workspaceId: f.workspace.id } }), audits: await db.auditLog.findMany({ where: { workspaceId: f.workspace.id } }) });
    const list = await listStripeReceipts(db, f.workspace.id, { page: 1 }); expect(list.rows.map(row => row.state).sort()).toEqual(["Failed", "Incomplete", "Pending"]);
    expect(list.rows.find(row => row.id === pending)?.eventType).toBe("payment_intent.payment_failed");
    const detail = await loadStripeReceipt(db, f.workspace.id, incomplete, { page: 1 });
    expect(detail).toMatchObject({ state: "Incomplete", eventType: "payment_intent.succeeded", checkReason: "STRIPE_CONTRACT_NOT_CONFIGURED",
      fields: [{ name: "amount", presence: "present", jsonType: "string" }, { name: "currency", presence: "present", jsonType: "string" }, { name: "status", presence: "missing", jsonType: null }] });
    expect(detail?.verification?.verifiedAt).toBeTruthy();
    expect((await loadStripeReceipt(db, f.workspace.id, failed, { page: 1 }))?.state).toBe("Failed");
    const html = renderToStaticMarkup(createElement(StripeReceiptInspection, { receipt: detail! }));
    expect(html).toContain("Contract not configured"); expect(html).toContain("Present · string"); expect(html).toContain("Missing");
    expect(html).toContain("not independent verification"); expect(html).not.toContain("Passed");
    const serialized = JSON.stringify({ list, detail, html });
    for (const marker of ["private-value-not-for-view", "private-currency", "never-render-private-job-diagnostics", f.key.token, f.secret.value, f.secret.id, "collectorCredentialId", "protectedShape", "signingSecretId"]) expect(serialized).not.toContain(marker);
    const after = JSON.stringify({ receipts: await db.stripeWebhookReceipt.findMany({ where: { workspaceId: f.workspace.id } }), jobs: await db.outboxEvent.findMany({ where: { workspaceId: f.workspace.id } }), audits: await db.auditLog.findMany({ where: { workspaceId: f.workspace.id } }) });
    expect(after).toBe(before);
  });
  it("isolates list/detail by workspace and integration and refuses unsupported service/environment scope", async () => {
    const f = await fixture(), other = await fixture(), id = await f.accept();
    expect((await listStripeReceipts(db, other.workspace.id, { page: 1 })).rows).toEqual([]);
    expect(await loadStripeReceipt(db, other.workspace.id, id, { page: 1 })).toBeNull();
    expect((await listStripeReceipts(db, f.workspace.id, { page: 1, integrationId: other.integration.id })).total).toBe(0);
    expect(await loadStripeReceipt(db, f.workspace.id, id, { page: 1, integrationId: other.integration.id })).toBeNull();
    expect((await listStripeReceipts(db, f.workspace.id, { page: 1, integrationId: f.integration.id })).total).toBe(1);
    for (const filter of [{ page: 1, environment: "default" }, { page: 1, service: "payments-api" }]) {
      expect(await listStripeReceipts(db, f.workspace.id, filter)).toMatchObject({ rows: [], scopeUnsupported: true });
      expect(await loadStripeReceipt(db, f.workspace.id, id, filter)).toBeNull();
    }
    expect(await loadStripeReceipt(db, f.workspace.id, "invalid", { page: 1 })).toBeNull();
    expect(await loadStripeReceipt(db, f.workspace.id, randomUUID(), { page: 1 })).toBeNull();
  });
  it("paginates a stable tied-time order without exporting stored evidence blobs", async () => {
    const f = await fixture(), original = await f.accept(), row = await db.stripeWebhookReceipt.findUniqueOrThrow({ where: { id: original } });
    const acceptedAt = new Date("2026-10-26T01:00:00Z");
    await db.stripeWebhookReceipt.createMany({ data: Array.from({ length: 21 }, () => ({ workspaceId: f.workspace.id, integrationId: f.integration.id,
      collectorCredentialId: f.key.credential.id, sourceEventId: `evt_${randomUUID().replaceAll("-", "")}`, eventType: row.eventType, eventCreatedAt: row.eventCreatedAt,
      receivedAt: acceptedAt, reportedApiVersion: row.reportedApiVersion, protectedShape: { neverExport: "unique-list-payload-secret" }, verification: {}, validationStatus: "UNSUPPORTED" as const })) });
    const first = await listStripeReceipts(db, f.workspace.id, { page: 1 }), second = await listStripeReceipts(db, f.workspace.id, { page: 2 });
    expect(first.rows).toHaveLength(20); expect(second.rows).toHaveLength(2); expect(first.pages).toBe(2);
    expect(new Set([...first.rows, ...second.rows].map(row => row.id)).size).toBe(22);
    expect((await listStripeReceipts(db, f.workspace.id, { page: 1 })).rows).toEqual(first.rows);
    expect(JSON.stringify(first)).not.toContain("unique-list-payload-secret");
    expect((await listStripeReceipts(db, f.workspace.id, { page: 3 })).rows).toEqual([]);
  });
  it("withholds unknown/malformed shapes, mismatched verification and arbitrary validation text", async () => {
    const f = await fixture(), id = await f.accept(), row = await db.stripeWebhookReceipt.findUniqueOrThrow({ where: { id } });
    const badId = randomUUID();
    await db.stripeWebhookReceipt.create({ data: { id: badId, workspaceId: f.workspace.id, integrationId: f.integration.id, collectorCredentialId: f.key.credential.id,
      sourceEventId: "evt_malformed", eventType: row.eventType, eventCreatedAt: row.eventCreatedAt, reportedApiVersion: row.reportedApiVersion,
      protectedShape: { policy: "future", private: "never-display-shape-value" }, verification: { private: "never-display-verification" },
      validationStatus: "PASSED", validationEvidence: { private: "never-display-validation" } } });
    const detail = await loadStripeReceipt(db, f.workspace.id, badId, { page: 1 });
    expect(detail).toMatchObject({ state: "Incomplete", fields: null, verification: null, checkReason: null });
    const html = renderToStaticMarkup(createElement(StripeReceiptInspection, { receipt: detail! }));
    expect(html).toContain("Stored content is withheld"); expect(html).toContain("Verification metadata unavailable");
    expect(JSON.stringify({ detail, html })).not.toContain("never-display-");
    const proof = row.verification as Record<string, string | number | boolean | null>;
    const spoof = await db.stripeWebhookReceipt.create({ data: { workspaceId: f.workspace.id, integrationId: f.integration.id, collectorCredentialId: f.key.credential.id,
      sourceEventId: "evt_transplanted", eventType: row.eventType, eventCreatedAt: row.eventCreatedAt, reportedApiVersion: row.reportedApiVersion,
      protectedShape: row.protectedShape!, verification: { ...proof, workspaceId: randomUUID() }, validationStatus: "UNSUPPORTED" } });
    expect((await loadStripeReceipt(db, f.workspace.id, spoof.id, { page: 1 }))?.verification).toBeNull();
  });
});
