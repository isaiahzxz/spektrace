import { config as loadEnv } from "dotenv";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import next from "next";
import nextConfig from "../next.config";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { assertVerificationDatabaseTarget } from "./lib/real-model-verification-harness";
import { registerApiSpec, activateApiSpecRevision } from "@/server/repositories/api-specs";
import { submitIncident } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { generatePayloadProposal } from "@/server/review/payload-proposal";
import { createPayloadProposalGateway } from "@/server/review/payload-proposal-gateway";
import { proposalInputSchema } from "@/lib/payload-proposal/contract";
import { inspectProposalResponse, type ProposalResponseDiagnostic } from "@/lib/payload-proposal/response-diagnostics";

loadEnv({ quiet: true });
let phase = "configuration";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function bytes(req: IncomingMessage, maximum: number) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk); size += part.length;
    if (size > maximum) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
}
async function serve() {
  const app = next({ dev: true, dir: path.resolve(".next-proposal-review/app"), hostname: "127.0.0.1", port: 3002 });
  await app.prepare();
  const handler = app.getRequestHandler();
  const web = createServer(async (req, res) => {
    if (req.headers.host !== "127.0.0.1:3002" || (req.headers.origin && req.headers.origin !== "http://127.0.0.1:3002")) { res.writeHead(403).end(); return; }
    await handler(req, res);
  });
  await listen(web, 3002);
  console.log("ISOLATED_REVIEW_SERVER_READY");
}
async function main() {
  const uiOnly = process.argv.slice(2).join(" ") === "--ui-only";
  if (!uiOnly && process.argv.slice(2).join(" ") !== "--one-live-request") throw new Error("Explicit verification mode required");
  const target = assertVerificationDatabaseTarget();
  const testUrl = requireTestDatabaseUrl();
  const realKey = uiOnly ? undefined : process.env.THESYS_API_KEY?.trim();
  const upstream = `${(process.env.SPEKTRACE_AI_GATEWAY_BASE_URL || "https://api.thesys.dev/v1/embed").replace(/\/$/, "")}/chat/completions`;
  if (!uiOnly && (!realKey || upstream !== "https://api.thesys.dev/v1/embed/chat/completions")) throw new Error("CONFIGURATION_UNAVAILABLE");
  const db = createPrismaClientForUrl(testUrl);
  phase = "baseline-read";
  const originals = {
    incidents: await db.incident.findMany({ orderBy: { id: "asc" } }),
    specs: await db.apiSpec.findMany({ orderBy: { id: "asc" } }),
  };
  const oldEnv = { ...process.env };
  let child: ChildProcess | undefined; let proxy: Server | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  const finish = async () => {
    if (closing) return; closing = true;
    if (timer) clearTimeout(timer);
    child?.kill();
    proxy?.closeAllConnections(); proxy?.close();
    await db.$disconnect();
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  };
  try {
    phase = "synthetic-fixtures";
    process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = "false";
    const workspace = await db.workspace.create({ data: { name: "Synthetic proposal review only", slug: `proposal-review-${randomUUID()}` } });
    const document = { openapi: "3.1.0", paths: { "/payments": { post: { requestBody: { content: { "application/json": { schema: { type: "object", required: ["amount"], properties: { amount: { type: "integer" } } } } } } } } } };
    const sourceText = JSON.stringify(document);
    const spec = await registerApiSpec(db, { workspaceId: workspace.id, apiKey: "payments-api", name: "Synthetic payments", version: "1.0.0", openApiVersion: "3.1.0", sourceFilename: "synthetic.json", sourceText, sourceSha256: createHash("sha256").update(sourceText).digest("hex"), parsedDocument: document });
    await activateApiSpecRevision(db, workspace.id, spec.id);
    const fixtures = [];
    for (const amount of ["100", "12.5"] as const) {
      const submitted = await submitIncident(db, workspace.id, { source: "WEBHOOK", sourceEventId: randomUUID(), apiKey: "payments-api", httpMethod: "POST", requestPath: "/payments", statusCode: 400, occurredAt: new Date().toISOString(), sanitizedRequestBody: { amount } });
      await processIncidentValidation(db, workspace.id, submitted.incident.id);
      fixtures.push({ amount, incidentId: submitted.incident.id });
    }
    const initialFixtures = await db.incident.findMany({ where: { workspaceId: workspace.id }, orderBy: { id: "asc" } });
    const initialOutbox = await db.outboxEvent.findMany({ where: { workspaceId: workspace.id }, orderBy: { id: "asc" } });
    let attempts = 0; let acceptedPlan: unknown = null; let gatewayStatus: number | null = null;
    let responseDiagnostic: ProposalResponseDiagnostic | null = null;
    const status = async () => {
      const current = { incidents: await db.incident.findMany({ where: { id: { in: originals.incidents.map(r => r.id) } }, orderBy: { id: "asc" } }), specs: await db.apiSpec.findMany({ where: { id: { in: originals.specs.map(r => r.id) } }, orderBy: { id: "asc" } }) };
      const currentFixtures = await db.incident.findMany({ where: { workspaceId: workspace.id }, orderBy: { id: "asc" } });
      const currentSpec = await db.apiSpec.findFirst({ where: { id: spec.id } });
      const evidence = (rows: typeof currentFixtures) => rows.map(row => ({ id: row.id, sanitizedRequestBody: row.sanitizedRequestBody, validationEvidence: row.validationEvidence, validationStatus: row.validationStatus, apiSpecId: row.apiSpecId, sentAt: row.sentAt }));
      const syntheticApprovals = await Promise.all(currentFixtures.map(async row => ({ incidentId: row.id, status: row.status, approvedBy: row.approvedBy, approvedAt: row.approvedAt, approvalEventCount: await db.auditLog.count({ where: { workspaceId: workspace.id, incidentId: row.id, eventType: "INCIDENT_APPROVED" } }) })));
      const currentOutbox = await db.outboxEvent.findMany({ where: { workspaceId: workspace.id }, orderBy: { id: "asc" } });
      return { mode: uiOnly ? "ui-only-no-provider" : "one-live-proposal-browser-review", databaseName: target.databaseName, resetPerformed: false, attempts, gatewayStatus, acceptedPlan, responseDiagnostic, existingRecordsUnchanged: digest(originals) === digest(current), syntheticOriginalsUnchanged: digest(initialFixtures) === digest(currentFixtures), syntheticRequestEvidenceUnchanged: digest(evidence(initialFixtures)) === digest(evidence(currentFixtures)), syntheticOutboxUnchanged: digest(initialOutbox) === digest(currentOutbox), syntheticApprovals, activeSpecUnchanged: currentSpec?.sourceSha256 === spec.sourceSha256 && currentSpec?.isActive === true, humanReviewComplete: false };
    };
    let expectedBody = "";
    phase = "offline-request-envelope";
    const actualFetch = globalThis.fetch;
    process.env.SPEKTRACE_PAYLOAD_PROPOSAL_MODEL = "openai/gpt-4.1";
    if (uiOnly) process.env.THESYS_API_KEY = "offline-ui-review-no-provider";
    globalThis.fetch = async (_input, init) => {
      expectedBody = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "abstain", reasonCode: "INSUFFICIENT_EVIDENCE" }) } }] }), { status: 200 });
    };
    try { await generatePayloadProposal(db, workspace.id, fixtures[0]!.incidentId, createPayloadProposalGateway()); }
    finally { globalThis.fetch = actualFetch; }
    if (!expectedBody) throw new Error("SYNTHETIC_REQUEST_NOT_AVAILABLE");
    const expectedInput = proposalInputSchema.parse(JSON.parse(JSON.parse(expectedBody).messages[1].content));
    const token = randomUUID();
    proxy = createServer(async (req, res) => {
      try {
        if (req.headers.host === "127.0.0.1:3003" && !req.headers.origin && req.url === "/__verification/status" && req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(await status())); return; }
        if (uiOnly) { res.writeHead(403).end(); return; }
        if (req.headers.host !== "127.0.0.1:3003" || req.headers.origin || req.method !== "POST" || req.url !== "/chat/completions" || req.headers.authorization !== `Bearer ${token}` || req.headers["content-type"] !== "application/json") { res.writeHead(403).end(); return; }
        if (await bytes(req, 16_384) !== expectedBody) { res.writeHead(403).end(); return; }
        if (attempts >= 1) { res.writeHead(429).end(); return; }
        attempts++;
        const response = await actualFetch(upstream, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${realKey}`, "Content-Type": "application/json" }, body: expectedBody, signal: AbortSignal.timeout(30_000) });
        gatewayStatus = response.status;
        if (!response.body) { res.writeHead(502).end(); return; }
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
        try { while (true) { const part = await reader.read(); if (part.done) break; count += part.value.length; if (count > 8_192) { await reader.cancel(); throw new Error("RESPONSE_TOO_LARGE"); } chunks.push(part.value); } }
        finally { reader.releaseLock(); }
        const body = Buffer.concat(chunks);
        if (response.ok) {
          const inspected = inspectProposalResponse(body.toString("utf8"), expectedInput, response.status);
          responseDiagnostic = inspected.diagnostic;
          if (inspected.ok) acceptedPlan = inspected.plan;
          res.writeHead(200, { "Content-Type": "application/json" }).end(body);
        } else res.writeHead(response.status).end();
      } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
    });
    await listen(proxy, 3003);
    phase = "isolated-server-startup";
    await mkdir(".next-proposal-review/app", { recursive: true });
    await cp("src", ".next-proposal-review/app/src", { recursive: true });
    await cp("public", ".next-proposal-review/app/public", { recursive: true });
    await cp("package.json", ".next-proposal-review/app/package.json");
    await cp("postcss.config.mjs", ".next-proposal-review/app/postcss.config.mjs");
    const tsconfig = JSON.parse(await readFile("tsconfig.json", "utf8"));
    await writeFile(".next-proposal-review/app/tsconfig.json", JSON.stringify(tsconfig, null, 2));
    await writeFile(".next-proposal-review/app/next.config.mjs", `export default ${JSON.stringify({ ...nextConfig, turbopack: { root: process.cwd() } })};`);
    child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--serve"], { env: { ...process.env, NODE_ENV: "development", DATABASE_URL: testUrl, SPEKTRACE_INTERNAL_WORKSPACE_ID: workspace.id, SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED: uiOnly ? "false" : "true", THESYS_API_KEY: uiOnly ? "" : token, SPEKTRACE_AI_GATEWAY_BASE_URL: "http://127.0.0.1:3003" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const startup = setTimeout(() => reject(new Error("STARTUP_TIMEOUT")), 90_000);
      child!.once("error", reject); child!.once("exit", (code, signal) => { clearTimeout(startup); reject(new Error(`CHILD_STOPPED_${code ?? signal}`)); });
      child!.stderr?.on("data", (chunk: Buffer) => {
        if (ready) return;
        let line = chunk.toString();
        for (const [key, value] of Object.entries(process.env)) if (/(?:KEY|TOKEN|PASSWORD|DATABASE_URL|REDIS_URL)/i.test(key) && value) line = line.split(value).join("[REDACTED]");
        line = line.split(token).join("[LOCAL_TOKEN]").replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/g, "[URL]");
        console.error(`Isolated startup: ${line.slice(0, 1000)}`);
      });
      child!.stdout?.on("data", (chunk: Buffer) => {
        if (ready) return;
        let line = chunk.toString();
        if (line.includes("ISOLATED_REVIEW_SERVER_READY")) { ready = true; clearTimeout(startup); resolve(); return; }
        for (const [key, value] of Object.entries(process.env)) if (/(?:KEY|TOKEN|PASSWORD|DATABASE_URL|REDIS_URL)/i.test(key) && value) line = line.split(value).join("[REDACTED]");
        line = line.split(token).join("[LOCAL_TOKEN]").replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/g, "[URL]");
        console.log(`Isolated startup: ${line.slice(0, 1000)}`);
      });
    });
    console.log(JSON.stringify({ ready: true, mode: uiOnly ? "ui-only-no-provider" : "isolated-synthetic-browser-review", databaseName: target.databaseName, resetPerformed: false, maxProviderAttempts: uiOnly ? 0 : 1, fixtures: fixtures.map(f => ({ ...f, url: `http://127.0.0.1:3002/dashboard/incidents?incident=${f.incidentId}&inspect=1#synthetic-test` })), statusUrl: "http://127.0.0.1:3003/__verification/status" }));
    const reportAndFinish = async () => { try { console.log(JSON.stringify(await status())); } finally { await finish(); process.exit(0); } };
    timer = setTimeout(() => { void reportAndFinish(); }, 15 * 60_000);
    process.once("SIGINT", () => { void reportAndFinish(); });
    process.once("SIGTERM", () => { void reportAndFinish(); });
  } catch (error: unknown) { await finish(); throw error; }
}
if (process.argv.slice(2).join(" ") === "--serve") void serve().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : "Unknown server failure";
  for (const [key, value] of Object.entries(process.env)) if (/(?:KEY|TOKEN|PASSWORD|DATABASE_URL|REDIS_URL)/i.test(key) && value) message = message.split(value).join("[REDACTED]");
  message = message.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/g, "[URL]").slice(0, 500);
  console.error(`ISOLATED_SAFE_ERROR:${message}`); process.exitCode = 1;
});
else main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : "Unknown verification failure";
  for (const [key, value] of Object.entries(process.env)) if (/(?:KEY|TOKEN|PASSWORD|DATABASE_URL|REDIS_URL)/i.test(key) && value) message = message.split(value).join("[REDACTED]");
  message = message.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/g, "[URL]").slice(0, 500);
  console.error(`Isolated proposal review failed at ${phase}: ${message}. No automatic retry.`); process.exitCode = 1;
});
