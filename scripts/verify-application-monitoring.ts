/**
 * Live-process verification for the synthetic application monitoring adapter.
 * Uses TEST_DATABASE_URL and an isolated Redis queue prefix only.
 * Does not reset the database or modify the parent shell's persistent env.
 */
import { config as loadEnv } from "dotenv";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireRedisUrl, requireTestDatabaseUrl } from "@/lib/env";
import { forwardApplicationHttpFailure, type ApplicationHttpFailureEvent } from "@/lib/ingestion/application-monitoring";
import { startExpressMonitoringFixture, EXPRESS_FIXTURE_CLIENT } from "./lib/express-monitoring-fixture";
import { EvidencePreparationRunStatus, ValidationStatus } from "@/generated/prisma/client";
import { activateApiSpecRevision, registerApiSpec } from "@/server/repositories/api-specs";
import { issueIngestionCredential, revokeIngestionCredential } from "@/server/services/ingestion-credentials";
import { assertVerificationDatabaseTarget } from "./lib/real-model-verification-harness";

loadEnv({ quiet: true });

async function reservePort(): Promise<number> {
  const configured = process.env.SPEKTRACE_APPMON_VERIFY_PORT?.trim();
  if (configured) {
    return Number(configured);
  }
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}
const TIMEOUT_MS = 90_000;
const POLL_MS = 750;

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttpOk(url: string, label: string, child: ChildProcess) {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited before readiness`);
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) {
        console.log(`[appmon-verify] ${label} ready (${response.status})`);
        return;
      }
    } catch {
      // retry
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label} did not become ready within ${TIMEOUT_MS}ms`);
}

function spawnLogged(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[child] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[child] ${chunk}`);
  });
  return child;
}

async function main() {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const target = assertVerificationDatabaseTarget();
  const testDatabaseUrl = requireTestDatabaseUrl();
  const redisUrl = requireRedisUrl();
  const runId = randomUUID().slice(0, 8);
  const redisPrefix = `spektrace-appmon-verify-${runId}`;
  const apiToken = `appmon-live-${randomUUID().replace(/-/g, "")}`;
  let sourceEventId = `appmon-live-${runId}`;
  let occurredAt = "2026-10-21T18:00:00.000Z";
  const expressMode = process.env.SPEKTRACE_APPMON_VERIFY_DRIVER === "express";

  const db = createPrismaClientForUrl(testDatabaseUrl);

  const baselineIds = {
    incidents: (await db.incident.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(
      (r) => r.id,
    ),
    specs: (await db.apiSpec.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(
      (r) => r.id,
    ),
    audits: (await db.auditLog.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(
      (r) => r.id,
    ),
    outbox: (await db.outboxEvent.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(
      (r) => r.id,
    ),
  };
  const baselineDigest = digest(
    await Promise.all([
      db.incident.findMany({ where: { id: { in: baselineIds.incidents } }, orderBy: { id: "asc" } }),
      db.apiSpec.findMany({ where: { id: { in: baselineIds.specs } }, orderBy: { id: "asc" } }),
      db.auditLog.findMany({ where: { id: { in: baselineIds.audits } }, orderBy: { id: "asc" } }),
      db.outboxEvent.findMany({ where: { id: { in: baselineIds.outbox } }, orderBy: { id: "asc" } }),
    ]),
  );

  const workspace = await db.workspace.create({
    data: {
      name: "Application monitoring live verify",
      slug: `appmon-live-${runId}`,
    },
  });
  const ingestion = await issueIngestionCredential(db, workspace.id, "Synthetic monitoring verification");

  const document = {
    openapi: "3.1.0",
    paths: {
      "/payments": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["amount"],
                  properties: { amount: { type: "integer" } },
                },
              },
            },
          },
        },
      },
    },
  };
  const sourceText = JSON.stringify(document);
  const spec = await registerApiSpec(db, {
    workspaceId: workspace.id,
    apiKey: "payments-api",
    environment: "default",
    name: "Appmon live verify payments",
    version: "1.0.0",
    openApiVersion: "3.1.0",
    sourceFilename: "appmon-live.json",
    sourceText,
    sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
    parsedDocument: document,
  });
  await activateApiSpecRevision(db, workspace.id, spec.id);

  const isolatedDistDir = `.next-appmon-verify-${runId}`;
  const isolatedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: testDatabaseUrl,
    REDIS_URL: redisUrl,
    SPEKTRACE_NEXT_DIST_DIR: isolatedDistDir,
    SPEKTRACE_REDIS_PREFIX: redisPrefix,
    SPEKTRACE_INTERNAL_API_TOKEN: apiToken,
    SPEKTRACE_INTERNAL_WORKSPACE_ID: workspace.id,
    SPEKTRACE_EVIDENCE_PREPARATION_ENABLED: "true",
    SPEKTRACE_AI_INVESTIGATION_ENABLED: "false",
    SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED: "false",
  };

  let appProc: ChildProcess | undefined;
  let workerProc: ChildProcess | undefined;
  let expressFixture: Awaited<ReturnType<typeof startExpressMonitoringFixture>> | undefined;
  let expressChecks: Record<string, unknown> | undefined;

  const shutdown = () => {
    for (const proc of [appProc, workerProc]) {
      if (proc?.pid && !proc.killed && proc.exitCode === null && proc.signalCode === null) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else { proc.kill("SIGTERM"); }
      }
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    workerProc = spawnLogged(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/workers/index.ts"], isolatedEnv);
    appProc = spawnLogged(
      process.execPath,
      ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
      isolatedEnv,
    );

    await waitForHttpOk(`${baseUrl}/dashboard`, "next-dev", appProc);
    await sleep(2000);

    const failure: ApplicationHttpFailureEvent = {
      sourceEventId,
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt,
      sanitizedRequestBody: { amount: "100" },
      clientReference: `appmon-live-${runId}`,
      client: {
        applicationName: "Synthetic Payments API",
        applicationVersion: "live-verify-1",
        platform: "node",
      },
    };

    if (expressMode) {
      expressFixture = await startExpressMonitoringFixture(baseUrl, ingestion.token);
      const delivered = await expressFixture.bodyOn.send();
      const observed = await db.incident.findFirstOrThrow({ where: { workspaceId: workspace.id, applicationName: EXPRESS_FIXTURE_CLIENT.applicationName, applicationVersion: "body-on" } });
      sourceEventId = observed.sourceEventId; occurredAt = observed.occurredAt.toISOString();
      failure.sourceEventId = sourceEventId; failure.occurredAt = occurredAt; failure.clientReference = undefined;
      failure.client = { ...EXPRESS_FIXTURE_CLIENT, applicationVersion: "body-on" };
      expressChecks = { optedInDelivery: delivered, applicationResponseUnchanged: true };
    }
    // In Express mode this is the identical HTTP retry of the middleware-generated event.
    const firstForward = await forwardApplicationHttpFailure(
      { baseUrl, bearerToken: ingestion.token },
      { apiKey: "payments-api", environment: "default" },
      failure,
    );
    if (!firstForward.ok) {
      throw new Error(`ingest failed: ${firstForward.code} ${firstForward.message}`);
    }
    const incidentId = firstForward.incidentId;

    type Stage =
      | "received"
      | "validated"
      | "grouped"
      | "evidence_ready"
      | "timeout";
    let stage: Stage = "received";
    const started = Date.now();
    let membershipId: string | null = null;
    let prepRunId: string | null = null;

    while (Date.now() - started < TIMEOUT_MS) {
      const incident = await db.incident.findUnique({ where: { id: incidentId } });
      if (!incident) {
        throw new Error("incident missing after ingest");
      }
      if (incident.validationStatus === ValidationStatus.MISMATCH) {
        stage = "validated";
      }
      const membership = await db.investigationGroupMembership.findFirst({
        where: { incidentId },
      });
      if (membership) {
        stage = "grouped";
        membershipId = membership.investigationGroupId;
      }
      if (membershipId) {
        const prep = await db.evidencePreparationRun.findFirst({
          where: { investigationGroupId: membershipId },
          orderBy: { createdAt: "desc" },
        });
        if (prep?.status === EvidencePreparationRunStatus.EVIDENCE_READY) {
          stage = "evidence_ready";
          prepRunId = prep.id;
          break;
        }
      }
      await sleep(POLL_MS);
    }
    if (stage !== "evidence_ready") {
      throw new Error(`processing stopped at stage=${stage}`);
    }

    const incident = await db.incident.findUniqueOrThrow({ where: { id: incidentId } });
    const prep = await db.evidencePreparationRun.findUniqueOrThrow({ where: { id: prepRunId! } });
    const summary = prep.protectedSummary as { aiInvestigationPerformed?: boolean } | null;

    await sleep(2000);
    async function incidentProcessingCounts() {
      return {
        audits: await db.auditLog.count({ where: { incidentId } }),
        prepRuns: await db.evidencePreparationRun.count({
          where: { investigationGroupId: membershipId! },
        }),
        inferenceRuns: await db.investigationInferenceRun.count({
          where: { workspaceId: workspace.id },
        }),
        memberships: await db.investigationGroupMembership.count({ where: { incidentId } }),
      };
    }
    const processingSnapshot = await incidentProcessingCounts();

    const secondForward = await forwardApplicationHttpFailure(
      { baseUrl, bearerToken: ingestion.token },
      { apiKey: "payments-api", environment: "default" },
      failure,
    );
    if (!secondForward.ok || secondForward.incidentId !== incidentId || !secondForward.deduplicated) {
      throw new Error("identical retry did not deduplicate");
    }

    const processingAfterRetry = await incidentProcessingCounts();
    if (JSON.stringify(processingSnapshot) !== JSON.stringify(processingAfterRetry)) {
      throw new Error(
        `duplicate ingest changed processing records: before=${JSON.stringify(processingSnapshot)} after=${JSON.stringify(processingAfterRetry)}`,
      );
    }

    const beforeDenied = await db.incident.count({ where: { workspaceId: workspace.id } });
    const denied = await forwardApplicationHttpFailure(
      { baseUrl, bearerToken: "wrong-bearer-token-wrong-bearer-token!!" },
      { apiKey: "payments-api", environment: "default" },
      {
        ...failure,
        sourceEventId: `appmon-denied-${runId}`,
      },
    );
    const afterDenied = await db.incident.count({ where: { workspaceId: workspace.id } });
    if (denied.ok || afterDenied !== beforeDenied) {
      throw new Error("wrong bearer should not create incidents");
    }

    if (expressFixture) {
      const bodyOffDelivery = await expressFixture.bodyOff.send();
      let bodyOffVerified = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const missing = await db.incident.findFirst({ where: { workspaceId: workspace.id, applicationName: EXPRESS_FIXTURE_CLIENT.applicationName, applicationVersion: "body-off" } });
        if (missing?.validationStatus === ValidationStatus.UNSUPPORTED &&
          (missing.validationEvidence as { reasonCode?: string } | null)?.reasonCode === "REQUEST_BODY_MISSING") {
          if (missing.sanitizedRequestBody !== null) throw new Error("Default Express middleware exported a request body");
          bodyOffVerified = true; break;
        }
        await sleep(500);
      }
      if (!bodyOffVerified) throw new Error("Body-off middleware did not demonstrate missing-body unsupported validation");
      expressChecks = { ...expressChecks, bodyOffDelivery, bodyOffValidation: "UNSUPPORTED / REQUEST_BODY_MISSING" };
    }
    const afterBaselineDigest = digest(
      await Promise.all([
        db.incident.findMany({ where: { id: { in: baselineIds.incidents } }, orderBy: { id: "asc" } }),
        db.apiSpec.findMany({ where: { id: { in: baselineIds.specs } }, orderBy: { id: "asc" } }),
        db.auditLog.findMany({ where: { id: { in: baselineIds.audits } }, orderBy: { id: "asc" } }),
        db.outboxEvent.findMany({ where: { id: { in: baselineIds.outbox } }, orderBy: { id: "asc" } }),
      ]),
    );
    if (baselineDigest !== afterBaselineDigest) throw new Error("Pre-existing verification records changed");
    const report = {
      verdict: "demonstrated",
      driver: expressMode ? "express-middleware" : "application-adapter",
      ...(expressChecks ? { expressChecks } : {}),
      databaseName: target.databaseName,
      redisPrefix,
      baseUrl,
      port,
      workspaceId: workspace.id,
      specId: spec.id,
      incidentId,
      sourceEventId,
      occurredAt,
      ingest: {
        ...(expressMode ? { retryOfMiddlewareEvent: firstForward } : { first: firstForward }),
        second: secondForward,
        denied: { ok: denied.ok, code: denied.ok ? null : denied.code },
      },
      observed: {
        validationStatus: incident.validationStatus,
        apiKey: incident.apiKey,
        environment: incident.environment,
        investigationGroupId: membershipId,
        evidencePreparationRunId: prepRunId,
        evidencePreparationStatus: prep.status,
        aiInvestigationPerformed: summary?.aiInvestigationPerformed ?? null,
        plainEnglishSummary:
          (incident.validationEvidence as { plainEnglishSummary?: string } | null)
            ?.plainEnglishSummary ?? null,
      },
      processingSnapshot,
      processingAfterRetry,
      inferenceRunCount: processingSnapshot.inferenceRuns,
      preExistingRecordsUnchanged: baselineDigest === afterBaselineDigest,
      dashboardUrl: `${baseUrl}/dashboard?incident=${incidentId}&inspect=1`,
      processes: {
        app: "npx next dev",
        worker: "npx tsx src/workers/index.ts",
        adapter: expressMode ? "@spektrace/express-monitoring" : "forwardApplicationHttpFailure",
        ingestionRoute: "POST /api/internal/incidents",
      },
    };

    await mkdir(path.join(process.cwd(), "docs", "verification"), { recursive: true });
    const reportPath = path.join(
      process.cwd(),
      "docs",
      "verification",
      `application-monitoring-checkpoint-${runId}.json`,
    );
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log("[appmon-verify] SUCCESS");
    console.log(`[appmon-verify] report=${reportPath}`);
    console.log(`[appmon-verify] dashboard=${report.dashboardUrl}`);
    console.log(JSON.stringify(report, null, 2));

    const pauseMs = Number(process.env.SPEKTRACE_APPMON_VERIFY_SCREENSHOT_PAUSE ?? "0");
    if (pauseMs > 0) {
      console.log(`[appmon-verify] keeping processes alive for ${pauseMs}ms for dashboard capture`);
      await sleep(pauseMs);
    }
  } finally {
    await expressFixture?.close();
    shutdown();
    await sleep(1500);
    await revokeIngestionCredential(db, workspace.id, ingestion.credential.id);
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    "[appmon-verify] FAILED:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
