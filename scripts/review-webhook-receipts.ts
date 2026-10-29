import "dotenv/config";
import { randomUUID, createHash, randomBytes, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { requireTestDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";
import { createPrismaClientForUrl } from "@/lib/db";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import { createSyntheticWebhookApp } from "@/server/webhooks/synthetic-express-app";
import { processWebhookValidation } from "@/server/services/process-webhook-validation";
import { createSignedSyntheticWebhookApp } from "@/server/webhooks/signed-synthetic-express-app";
import { importSenderBinding } from "@/server/services/sender-identity";

async function main() {
  const base = requireTestDatabaseUrl(); const name = `spektrace_test_history_${randomUUID().replaceAll("-", "")}`;
  if (!/^spektrace_test_history_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid disposable name");
  const admin = new Client({ connectionString: base }); await admin.connect(); let created = false;
  const reviewDir = path.resolve("work/webhook-runtime/receipt-review"); await mkdir(reviewDir, { recursive: true });
  let stop = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stop = true; });
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    const target = new URL(base); target.pathname = `/${name}`; deployMigrationsForUrl(target.toString());
    const db = createPrismaClientForUrl(target.toString());
    try {
      const workspace = await db.workspace.create({ data: { name: "Synthetic webhook review (disposable)", slug: `review-${randomUUID()}` } });
      const key = await issueIngestionCredential(db, workspace.id, "Disposable review collector");
      const document = { openapi: "3.1.0", paths: { "/payments": { post: { requestBody: { content: { "application/json": { schema: { type: "object", required: ["amount"], properties: { amount: { type: "integer" } } } } } } } } } };
      const source = JSON.stringify(document);
      const historical = await db.apiSpec.create({ data: { workspaceId: workspace.id, apiKey: "synthetic-webhook-payments", environment: "default", name: "Synthetic payments", version: "1.0.0", openApiVersion: "3.1.0",
        sourceFilename: "synthetic.json", sourceText: source, parsedDocument: document, sourceSha256: createHash("sha256").update(source).digest("hex"), isActive: true } });
      const configured = process.argv.includes("--configured-revision");
      if (configured) {
        await db.apiSpec.update({ where: { id: historical.id }, data: { isActive: false } });
        const newer = JSON.parse(source);
        newer.paths["/payments"].post.requestBody.content["application/json"].schema.properties.amount.type = "number";
        const newerSource = JSON.stringify(newer);
        await db.apiSpec.create({ data: { workspaceId: workspace.id, apiKey: "synthetic-webhook-payments", environment: "default", name: "Synthetic payments", version: "2.0.0", openApiVersion: "3.1.0",
          sourceFilename: "synthetic-v2.json", sourceText: newerSource, parsedDocument: newer, sourceSha256: createHash("sha256").update(newerSource).digest("hex"), isActive: true } });
      }
      const signed = configured || process.argv.includes("--signed") || process.argv.includes("--grouping");
      const signingKey = { keyId: randomUUID(), workspaceId: workspace.id, credentialId: key.credential.id,
        principalRef: randomUUID(), principalKind: "client_id" as const, secretHex: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        ...(configured ? { revisionBinding: { apiSpecId: historical.id, sourceSha256: historical.sourceSha256 } } : {}) };
      if (signed) await importSenderBinding(db, workspace.id, { ingestionCredentialId: key.credential.id, apiKey: "synthetic-webhook-payments", environment: "default",
        principalRef: signingKey.principalRef, principalKind: "client_id", senderKey: randomUUID(), displayName: "Synthetic review sender" });
      const ingress = (signed ? createSignedSyntheticWebhookApp(db, [signingKey]) : createSyntheticWebhookApp(db)).listen(0, "127.0.0.1"); await once(ingress, "listening");
      const address = ingress.address(); if (!address || typeof address === "string") throw new Error("No ingress address");
      const receipts: Record<string, string> = {};
      try {
        const scenarios: [string, { amount: string | number; email?: string }][] = [ ["passed", { amount: 100 }], ["mismatch", { amount: configured ? 100.5 : "100" }], ["incomplete", { amount: "100", email: "synthetic@example.test" }], ["failed", { amount: "100" }], ["pending", { amount: "100" }] ];
        if (process.argv.includes("--grouping")) scenarios.push(["related", { amount: "200" }]);
        for (const [label, body] of scenarios) {
          const event = randomUUID(); const timestamp = String(Math.floor(Date.now() / 1000)); const bytes = JSON.stringify(body);
          const requestPath = signed ? "/synthetic/signed-webhooks/payments" : "/synthetic/webhooks/payments";
          const signature = createHmac("sha256", Buffer.from(signingKey.secretHex, "hex")).update(`synthetic-hmac-sha256@1\nPOST\n${requestPath}\n${signingKey.keyId}\n${workspace.id}\n${key.credential.id}\nclient_id\n${signingKey.principalRef}\n${event}\n${timestamp}\n`).update(bytes).digest("hex");
          const response = await fetch(`http://127.0.0.1:${address.port}${requestPath}`, { method: "POST", headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json", "x-spek-event-id": event,
            ...(signed ? { "x-spek-key-id": signingKey.keyId, "x-spek-timestamp": timestamp, "x-spek-signature": `v1=${signature}` } : {}) }, body: bytes });
          if (response.status !== 202) throw new Error("Synthetic acceptance failed");
          const { receiptId } = await response.json(); receipts[label] = receiptId;
          if (label !== "pending" && label !== "failed") await processWebhookValidation(db, workspace.id, receiptId);
          if (label === "failed") await db.outboxEvent.updateMany({ where: { webhookReceiptId: receiptId }, data: { dispatchStatus: "FAILED", lastError: "SYNTHETIC_DISPLAY_FIXTURE" } });
        }
      } finally { ingress.closeAllConnections(); await new Promise<void>((resolve) => ingress.close(() => resolve())); }
      const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3003"], {
        cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "development", DATABASE_URL: target.toString(),
          SPEKTRACE_INTERNAL_WORKSPACE_ID: workspace.id, SPEKTRACE_REDIS_PREFIX: `review-${randomUUID()}`, SPEKTRACE_NEXT_DIST_DIR: `.next-history-build-${randomUUID()}`,
          SPEKTRACE_AI_INVESTIGATION_ENABLED: "false", SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED: "false" },
      });
      const logs: string[] = []; child.stdout.on("data", (data) => logs.push(data.toString())); child.stderr.on("data", (data) => logs.push(data.toString()));
      await writeFile(path.join(reviewDir, "control.json"), "{}");
      await writeFile(path.join(reviewDir, "ready.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:3003/dashboard/webhooks", receipts, disposable: true, failedState: "synthetic display fixture; real terminal failures covered by integration test" }));
      console.log("Disposable review ready at http://127.0.0.1:3003/dashboard/webhooks");
      try {
        const deadline = Date.now() + 15 * 60_000; let advanced = false;
        while (!stop && Date.now() < deadline && child.exitCode === null) {
          const control = await readFile(path.join(reviewDir, "control.json"), "utf8").catch(() => "{}");
          const command = JSON.parse(control) as { completePending?: boolean; stop?: boolean };
          if (command.completePending && !advanced) { await processWebhookValidation(db, workspace.id, receipts.pending); advanced = true; console.log("Pending synthetic receipt validated."); }
          if (command.stop) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
        await writeFile(path.join(reviewDir, "server.log"), logs.join(""));
      }
    } finally { await db.$disconnect(); }
  } finally { try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); } finally { await admin.end(); } }
}
main().catch(() => { console.error("Disposable receipt review failed; connection details withheld."); process.exitCode = 1; });
