import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { createSignedSyntheticWebhookApp } from "@/server/webhooks/signed-synthetic-express-app";
import { createSyntheticWebhookApp } from "@/server/webhooks/synthetic-express-app";
import { createSyntheticSignatureVerifier, signingProofContext, SIGNED_WEBHOOK_PATH, type SyntheticSigningKey } from "@/server/webhooks/synthetic-signature";
import { acceptSyntheticWebhook } from "@/server/services/accept-synthetic-webhook";
import { issueIngestionCredential, revokeIngestionCredential } from "@/server/services/ingestion-credentials";
import { importSenderBinding, revokeSenderBinding } from "@/server/services/sender-identity";
import { processWebhookValidation } from "@/server/services/process-webhook-validation";
import { loadWebhookReceipt } from "@/server/dashboard/webhook-receipts";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? "")) throw new Error("Use disposable webhook signing verification");
const db = createPrismaClientForUrl(url); afterAll(() => db.$disconnect());
async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Synthetic signing", slug: `signing-${randomUUID()}` } });
  const credential = await issueIngestionCredential(db, workspace.id, "Synthetic signed collector");
  const key: SyntheticSigningKey = { keyId: randomUUID(), workspaceId: workspace.id, credentialId: credential.credential.id,
    principalRef: randomUUID(), principalKind: "client_id", secretHex: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  const binding = await importSenderBinding(db, workspace.id, { ingestionCredentialId: key.credentialId, apiKey: "synthetic-webhook-payments",
    environment: "default", principalRef: key.principalRef, principalKind: key.principalKind, senderKey: randomUUID(), displayName: "Synthetic sender" });
  return { workspace, credential, key, binding };
}
// Independent protocol construction: do not call the verifier's implementation to generate signatures.
function headers(key: SyntheticSigningKey, token: string, eventId: string, body: string | Buffer, seconds = Math.floor(Date.now() / 1000)) {
  const prefix = `synthetic-hmac-sha256@1\nPOST\n/synthetic/signed-webhooks/payments\n${key.keyId}\n${key.workspaceId}\n${key.credentialId}\n${key.principalKind}\n${key.principalRef}\n${eventId}\n${seconds}\n`;
  return { authorization: `Bearer ${token}`, "content-type": "application/json", "x-spek-event-id": eventId,
    "x-spek-key-id": key.keyId, "x-spek-timestamp": String(seconds), "x-spek-signature": `v1=${createHmac("sha256", Buffer.from(key.secretHex, "hex")).update(prefix).update(body).digest("hex")}` };
}
async function listen(keys: SyntheticSigningKey[], client = db, unsigned = false) {
  const server = (unsigned ? createSyntheticWebhookApp(client) : createSignedSyntheticWebhookApp(client, keys)).listen(0, "127.0.0.1");
  await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  return { server, base: `http://127.0.0.1:${address.port}`, endpoint: `http://127.0.0.1:${address.port}${SIGNED_WEBHOOK_PATH}` };
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
const body = '{"amount":"100"}';
describe("signed synthetic webhook boundary", () => {
  it("verifies original bytes and mapped sender, dedupes fresh signatures, preserves first provenance and validates separately", async () => {
    const f = await fixture(); const rotated = { ...f.key, keyId: randomUUID(), secretHex: randomBytes(32).toString("hex") };
    const app = await listen([f.key, rotated]); const eventId = randomUUID();
    try {
      const send = (key: SyntheticSigningKey, seconds?: number) => fetch(app.endpoint, { method: "POST", headers: headers(key, f.credential.token, eventId, body, seconds), body });
      const responses = await Promise.all([send(f.key), send(f.key)]); expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
      const first = await responses[0].json(); const row = await db.webhookReceipt.findUniqueOrThrow({ where: { id: first.receiptId } });
      expect(row.senderVerification).toMatchObject({ protocol: "synthetic-hmac-sha256@1", basis: "configured_signing_key_possession",
        senderId: f.binding.binding.senderId, bindingId: f.binding.binding.id, originalProviderVerified: false });
      expect(row.validationStatus).toBe("NOT_RUN");
      expect((await send(rotated, Math.floor(Date.now() / 1000) - 1)).status).toBe(200);
      expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: row.id } })).senderVerification).toEqual(row.senderVerification);
      expect(await db.outboxEvent.count({ where: { webhookReceiptId: row.id } })).toBe(1);
      expect(JSON.stringify(row)).not.toContain(f.key.secretHex); expect(JSON.stringify(row)).not.toContain("v1=");
      expect((await loadWebhookReceipt(db, f.workspace.id, row.id, { page: 1 }))?.verificationLabel).toBe("Synthetic signing key verified");
      await processWebhookValidation(db, f.workspace.id, row.id);
      expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: row.id } })).validationStatus).toBe("UNSUPPORTED"); // no fixture spec
      await expect(db.webhookReceipt.update({ where: { id: row.id }, data: { senderVerification: { forged: true } } })).rejects.toThrow();
      expect(await db.incident.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.investigationInferenceRun.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { await close(app.server); }
  });
  it("rejects byte, event, timestamp and key tampering before any durable write", async () => {
    const f = await fixture(); const app = await listen([f.key]); const event = randomUUID(); const h = headers(f.key, f.credential.token, event, body);
    try {
      for (const [changed, sentBody] of [[{}, body + " "], [{ "x-spek-event-id": randomUUID() }, body],
        [{ "x-spek-timestamp": String(Number(h["x-spek-timestamp"]) - 1) }, body], [{ "x-spek-key-id": randomUUID() }, body],
        [{ "x-spek-signature": "v1=" + "0".repeat(64) }, body], [{ "x-spek-signature": "v1=bad" }, body]] as const) {
        expect((await fetch(app.endpoint, { method: "POST", headers: { ...h, ...changed }, body: sentBody })).status).toBe(401);
      }
      expect(await db.webhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { await close(app.server); }
  });
  it("rejects stale and future signatures, expired keys, unsupported encodings and parser failures without leaking input", async () => {
    const f = await fixture(); const expired = { ...f.key, keyId: randomUUID(), secretHex: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() - 1000).toISOString() };
    const app = await listen([f.key, expired]); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const seconds of [Math.floor(Date.now() / 1000) - 301, Math.floor(Date.now() / 1000) + 32])
        expect((await fetch(app.endpoint, { method: "POST", headers: headers(f.key, f.credential.token, randomUUID(), body, seconds), body })).status).toBe(401);
      expect((await fetch(app.endpoint, { method: "POST", headers: headers(expired, f.credential.token, randomUUID(), body), body })).status).toBe(401);
      for (const bad of ['{"password":"private-parser-secret",broken', '{"amount":"person@example.test"}', "x".repeat(4097)]) {
        const response = await fetch(app.endpoint, { method: "POST", headers: headers(f.key, f.credential.token, randomUUID(), bad), body: bad });
        expect(response.status).toBe(bad.length > 4096 ? 413 : 400); expect(await response.text()).not.toContain("private-parser-secret");
      }
      for (const override of [{ "content-encoding": "gzip" }, { "content-type": "application/json; charset=utf-16" }] as Record<string, string>[])
        expect((await fetch(app.endpoint, { method: "POST", headers: { ...headers(f.key, f.credential.token, randomUUID(), body), ...override }, body })).status).toBe(415);
      expect(log).not.toHaveBeenCalled(); expect(await db.webhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { log.mockRestore(); await close(app.server); }
  });
  it("rejects duplicate auth/signature headers and exact-target aliases without unsigned fallback", async () => {
    const f = await fixture(); const app = await listen([f.key]); const h = headers(f.key, f.credential.token, randomUUID(), body);
    try {
      for (const name of ["authorization", "x-spek-event-id", "x-spek-key-id", "x-spek-timestamp", "x-spek-signature", "content-type"]) {
        const status = await new Promise<number>((resolve, reject) => {
          const pairs = Object.entries(h).flat(); pairs.push("host", new URL(app.endpoint).host, "content-length", String(Buffer.byteLength(body)), name, h[name as keyof typeof h]);
          const req = request(app.endpoint, { method: "POST", headers: pairs }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
          req.on("error", reject); req.end(body);
        }); expect(status, `duplicate ${name}`).toBe(name === "content-type" ? 415 : 401);
      }
      for (const path of [SIGNED_WEBHOOK_PATH + "?x=1", SIGNED_WEBHOOK_PATH + "/", SIGNED_WEBHOOK_PATH.toUpperCase(), "/synthetic/webhooks/payments"])
        expect((await fetch(app.base + path, { method: "POST", headers: h, body })).status).toBe(404);
      const missing = { ...h }; delete (missing as Partial<typeof h>)["x-spek-signature"];
      expect((await fetch(app.endpoint, { method: "POST", headers: missing, body })).status).toBe(401);
      expect(await db.webhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { await close(app.server); }
  });
  it("rejects wrong collector/workspace scope, unmapped or revoked bindings and revoked collectors", async () => {
    const f = await fixture(); const other = await fixture(); const unmapped = { ...f.key, keyId: randomUUID(), secretHex: randomBytes(32).toString("hex"), principalRef: randomUUID() };
    const app = await listen([f.key, unmapped]);
    try {
      const send = (key = f.key, token = f.credential.token) => fetch(app.endpoint, { method: "POST", headers: headers(key, token, randomUUID(), body), body });
      expect((await send(f.key, other.credential.token)).status).toBe(401);
      expect((await send(unmapped)).status).toBe(401);
      await revokeSenderBinding(db, f.workspace.id, f.binding.binding.id); expect((await send()).status).toBe(401);
      await revokeIngestionCredential(db, f.workspace.id, f.key.credentialId); expect((await send()).status).toBe(401);
      expect(await db.webhookReceipt.count({ where: { workspaceId: { in: [f.workspace.id, other.workspace.id] } } })).toBe(0);
    } finally { await close(app.server); }
  });
  it("binds proof to event and protected payload, preserves omission policy, and conflicts on changed sender or unsigned provenance", async () => {
    const f = await fixture(); const app = await listen([f.key]); const event = randomUUID();
    try {
      const raw = '{"amount":"100","email":"private-signing@example.test"}';
      const h = headers(f.key, f.credential.token, event, raw);
      const proof = createSyntheticSignatureVerifier([f.key])(Object.entries(h).flat(), Buffer.from(raw), "POST", SIGNED_WEBHOOK_PATH);
      const c = signingProofContext(proof);
      await expect(acceptSyntheticWebhook(db, f.credential.token, randomUUID(), c.body, proof)).rejects.toThrow("signature");
      await expect(acceptSyntheticWebhook(db, f.credential.token, event, { payload: { amount: 100 }, protection: c.body.protection }, proof)).rejects.toThrow("signature");
      const result = await acceptSyntheticWebhook(db, f.credential.token, event, c.body, proof);
      const row = await db.webhookReceipt.findUniqueOrThrow({ where: { id: result.id } });
      expect(row.protection).toMatchObject({ omittedFields: ["email"] }); expect(JSON.stringify(row)).not.toContain("private-signing");
      const unsigned = await listen([], db, true);
      try { expect((await fetch(unsigned.base + "/synthetic/webhooks/payments", { method: "POST", headers: h, body: raw })).status).toBe(409); }
      finally { await close(unsigned.server); }
      const unsignedEvent = randomUUID(); await acceptSyntheticWebhook(db, f.credential.token, unsignedEvent, c.body);
      expect((await fetch(app.endpoint, { method: "POST", headers: headers(f.key, f.credential.token, unsignedEvent, raw), body: raw })).status).toBe(409);
      const different = await importSenderBinding(db, f.workspace.id, { ingestionCredentialId: f.key.credentialId, apiKey: "synthetic-webhook-payments", environment: "default",
        principalRef: randomUUID(), principalKind: "client_id", senderKey: randomUUID(), displayName: "Another synthetic sender" });
      const otherKey = { ...f.key, principalRef: different.binding.principalRef }; const secondApp = await listen([otherKey]);
      try { expect((await fetch(secondApp.endpoint, { method: "POST", headers: headers(otherKey, f.credential.token, event, raw), body: raw })).status).toBe(409); }
      finally { await close(secondApp.server); }
    } finally { await close(app.server); }
  });
  it("rechecks freshness after waiting for the event lock and rolls back without accepting", async () => {
    const f = await fixture(); const event = randomUUID(); const h = headers(f.key, f.credential.token, event, body);
    const proof = createSyntheticSignatureVerifier([f.key])(Object.entries(h).flat(), Buffer.from(body), "POST", SIGNED_WEBHOOK_PATH);
    const blocker = new Client({ connectionString: url }); await blocker.connect(); await blocker.query("BEGIN");
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const lock = JSON.stringify(["synthetic-webhook@1", f.workspace.id, f.key.credentialId, event]);
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lock]);
    const acceptance = acceptSyntheticWebhook(db, f.credential.token, event, signingProofContext(proof).body, proof).then(() => "accepted", () => "rejected");
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await blocker.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND $1::int = ANY(pg_blocking_pids(pid))", [blockerPid]);
        if (result.rows[0].n) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true); const realNow = Date.now(); clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 301_000);
      await blocker.query("COMMIT"); expect(await acceptance).toBe("rejected");
      expect(await db.webhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { clock?.mockRestore(); await blocker.query("ROLLBACK"); await blocker.end(); await acceptance; }
  });
});
