import "dotenv/config";
import { randomUUID, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { requireTestDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";
import { createPrismaClientForUrl } from "@/lib/db";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import { createStripeTestExpressApp } from "@/server/webhooks/stripe-test-express-app";
import { processStripeWebhookValidation } from "@/server/services/process-stripe-webhook-validation";

async function main() {
  const base = requireTestDatabaseUrl(), name = `spektrace_test_history_${randomUUID().replaceAll("-", "")}`;
  if (!/^spektrace_test_history_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid disposable database");
  const admin = new Client({ connectionString: base }); await admin.connect(); let created = false, stop = false;
  const reviewDir = path.resolve("work/webhook-runtime/stripe-review"); await mkdir(reviewDir, { recursive: true });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stop = true; });
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    const target = new URL(base); target.pathname = `/${name}`; deployMigrationsForUrl(target.toString());
    const db = createPrismaClientForUrl(target.toString());
    try {
      const workspace = await db.workspace.create({ data: { name: "Stripe synthetic review (disposable)", slug: `stripe-review-${randomUUID()}` } });
      const key = await issueIngestionCredential(db, workspace.id, "Disposable Stripe review");
      const integration = await db.stripeWebhookIntegration.create({ data: { workspaceId: workspace.id, ingestionCredentialId: key.credential.id } });
      const secret = { id: randomUUID(), value: `whsec_${randomUUID().replaceAll("-", "")}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
      const ingress = createStripeTestExpressApp(db, { workspaceId: workspace.id, integrationId: integration.id, mode: "test", secrets: [secret] }, key.token).listen(0, "127.0.0.1");
      await once(ingress, "listening"); const address = ingress.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const receipts: Record<string, string> = {};
      try {
        for (const label of ["pending", "incomplete", "succeeded", "failed"] as const) {
          const timestamp = Math.floor(Date.now() / 1000), body = JSON.stringify({ id: `evt_review${label}${randomUUID().replaceAll("-", "")}`, object: "event",
            type: label === "succeeded" ? "payment_intent.succeeded" : "payment_intent.payment_failed", created: timestamp - 60, livemode: false,
            api_version: "2026-09-30.clover", data: { object: { object: "payment_intent", amount: "100", currency: "usd", receipt_email: "synthetic-private@example.test" } } });
          const signature = createHmac("sha256", secret.value).update(`${timestamp}.${body}`).digest("hex");
          const response = await fetch(`http://127.0.0.1:${address.port}/stripe/test/webhooks`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body });
          if (response.status !== 202) throw new Error("Stripe fixture acceptance failed");
          receipts[label] = (await response.json()).receiptId;
          if (label === "incomplete" || label === "succeeded") await processStripeWebhookValidation(db, workspace.id, receipts[label]);
          if (label === "failed") await db.outboxEvent.updateMany({ where: { stripeWebhookReceiptId: receipts[label] }, data: { dispatchStatus: "FAILED", lastError: "SYNTHETIC_DISPLAY_FIXTURE" } });
        }
      } finally { ingress.closeAllConnections(); await new Promise<void>(resolve => ingress.close(() => resolve())); }
      const unsupported = await db.stripeWebhookReceipt.create({ data: { workspaceId: workspace.id, integrationId: integration.id, collectorCredentialId: key.credential.id,
        sourceEventId: `evt_unsupported${randomUUID().replaceAll("-", "")}`, eventType: "payment_intent.payment_failed", eventCreatedAt: new Date(),
        protectedShape: { policy: "unsupported-fixture", private: "never-display-private-shape" }, verification: {}, validationStatus: "PASSED" } });
      receipts.unsupported = unsupported.id;
      const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3003"], {
        cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "development", DATABASE_URL: target.toString(),
          SPEKTRACE_INTERNAL_WORKSPACE_ID: workspace.id, SPEKTRACE_REDIS_PREFIX: `stripe-review-${randomUUID()}`, SPEKTRACE_NEXT_DIST_DIR: `.next-stripe-review-${randomUUID()}`,
          SPEKTRACE_AI_INVESTIGATION_ENABLED: "false", SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED: "false", SPEKTRACE_STRIPE_TEST_ENABLED: "false" },
      });
      const logs: string[] = []; child.stdout.on("data", data => logs.push(data.toString())); child.stderr.on("data", data => logs.push(data.toString()));
      await writeFile(path.join(reviewDir, "control.json"), "{}");
      await writeFile(path.join(reviewDir, "ready.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:3003/dashboard/webhooks/stripe", receipts, integrationId: integration.id,
        disposable: true, failedAndUnsupported: "Explicit stored display fixtures; actual queue failures are covered separately by integration tests." }));
      console.log("Disposable Stripe review: http://127.0.0.1:3003/dashboard/webhooks/stripe");
      try {
        const deadline = Date.now() + 15 * 60_000; let advanced = false;
        while (!stop && Date.now() < deadline && child.exitCode === null) {
          const control = JSON.parse(await readFile(path.join(reviewDir, "control.json"), "utf8").catch(() => "{}")) as { stop?: boolean; completePending?: boolean };
          if (control.completePending && !advanced) { await processStripeWebhookValidation(db, workspace.id, receipts.pending); advanced = true; }
          if (control.stop) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      } finally {
        if (child.exitCode === null) { const ended = once(child, "exit"); child.kill(); await ended; }
        await writeFile(path.join(reviewDir, "server.log"), logs.join(""));
      }
    } finally { await db.$disconnect(); }
  } finally { try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); } finally { await admin.end(); } }
}
main().catch(() => { console.error("Disposable Stripe review failed; connection values withheld."); process.exitCode = 1; });
