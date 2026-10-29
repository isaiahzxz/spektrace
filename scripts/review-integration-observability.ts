import "dotenv/config";
import { randomUUID,createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile, readFile, open, rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { requireTestDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";
import { createPrismaClientForUrl } from "@/lib/db";
import { createOutboundObserver } from "@/lib/integration-observations/outbound-fetch";
import { manageResponseBaseline } from "@/server/integration-observations/baselines";
import { submitIncidentWithIngestionToken } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import {
  observabilityFixture,
  startCollector,
  startProvider,
  stopServer,
  drainIntegrationWork,
  requestSpec,
} from "./lib/integration-observability-fixture";
async function main() {
  const base = requireTestDatabaseUrl(),
    name = `spektrace_test_history_${randomUUID().replaceAll("-", "")}`;
  if (!/^spektrace_test_history_[a-f0-9]{32}$/.test(name))
    throw Error("Unsafe disposable target");
  const dir = path.resolve(
    "work/integration-observability",
    `review-${randomUUID()}`,
  );
  await mkdir(dir, { recursive: true });
  const admin = new Client({ connectionString: base });
  await admin.connect();
  let created = false,
    stop = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      stop = true;
    });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(base);
    url.pathname = `/${name}`;
    deployMigrationsForUrl(url.toString());
    const db = createPrismaClientForUrl(url.toString());
    try {
      const f = await observabilityFixture(db);
      await db.workspace.update({
        where: { id: f.workspace.id },
        data: { name: "Synthetic integration review (disposable)" },
      });
      const collector = await startCollector(db);
      const observations: Record<string, string> = {};
      try {
        for (const kind of ["payments", "crm"] as const) {
          const provider = await startProvider(kind);
          const integration = {
            key: `synthetic-${kind}`,
            provider: `fixture-${kind}`,
            environment: "test",
          };
          const observer = createOutboundObserver({
            collectorOrigin: collector.origin,
            providerOrigin: provider.origin,
            ingestionToken: f.key.token,
            integration,
            responsePointers:
              kind === "payments"
                ? ["/amount", "/status"]
                : ["/count", "/results"],
            providerVersionHeader: "x-api-version",
          });
          const operation = {
            method: "POST" as const,
            path: kind === "payments" ? "/payments" : "/contacts",
          };
          try {
            async function call(
              label: string,
              correlation?: { kind: "workflow"; id: string; attempt: number },
              signal?: AbortSignal,
              requestIncidentId?: string,
            ) {
              const callId = randomUUID();
              try {
                await (
                  await observer.fetch(
                    provider.origin + operation.path,
                    { method: "POST", signal },
                    { operation, callId, correlation, requestIncidentId },
                  )
                ).text();
              } catch (error) {
                if (!signal?.aborted) throw error;
              }
              const flushed = await observer.flush();
              if (!flushed.coverageDelivered)
                throw Error("Fixture collection unconfirmed");
              await drainIntegrationWork(db, f.workspace.id);
              const row = await db.integrationObservation.findFirstOrThrow({
                where: { workspaceId: f.workspace.id, callId },
              });
              observations[label] = row.id;
              return row;
            }
            const sample = await call(`${kind}-sample`);
            const b = await manageResponseBaseline(db, f.workspace.id, {
              action: "observe",
              observationId: sample.id,
            });
            await manageResponseBaseline(db, f.workspace.id, {
              action: "activate",
              baselineId: b.id,
            });
            provider.setMode("drift");
            const correlation = {
              kind: "workflow" as const,
              id: randomUUID(),
              attempt: 1,
            };
            let requestIncidentId: string | undefined;
            if (kind === "payments") {
              await requestSpec(db, f.workspace.id);
              const request = await submitIncidentWithIngestionToken(
                db,
                f.key.token,
                {
                  apiKey: integration.key,
                  environment: "test",
                  source: "WEBHOOK",
                  sourceEventId: randomUUID(),
                  httpMethod: "POST",
                  requestPath: "/payments",
                  statusCode: 400,
                  occurredAt: new Date().toISOString(),
                  sanitizedRequestBody: { amount: "100" },
                },
              );
              await processIncidentValidation(
                db,
                f.workspace.id,
                request.incident.id,
              );
              requestIncidentId = request.incident.id;
              const baseSpec=await db.apiSpec.findFirstOrThrow({where:{workspaceId:f.workspace.id,apiKey:integration.key,environment:'test'}});
              const document=JSON.parse(baseSpec.sourceText);document.info={title:'Synthetic payments',version:'1.1.0'};document.paths['/payments'].post.requestBody.content['application/json'].schema.properties.amount.type='number';const source=JSON.stringify(document);
              await db.apiSpec.create({data:{workspaceId:f.workspace.id,apiKey:integration.key,environment:'test',name:'Synthetic payments request and response contract',version:'1.1.0',openApiVersion:'3.1.0',sourceFilename:'synthetic-next.json',sourceText:source,parsedDocument:document,sourceSha256:createHash('sha256').update(source).digest('hex'),isActive:false}});
            }
            await call(
              `${kind}-drift`,
              correlation,
              undefined,
              requestIncidentId,
            );
            if (
              !(await observer.outcome({
                correlation,
                outcome: kind === "payments" ? "FAILED" : "SUCCEEDED",
              }))
            )
              throw Error("Fixture outcome unconfirmed");
            await drainIntegrationWork(db, f.workspace.id);
            await observer.outcome({
              correlation: { kind: "workflow", id: randomUUID(), attempt: 1 },
              outcome: "FAILED",
            });
            await drainIntegrationWork(db, f.workspace.id);
            provider.setMode("timeout");
            await call(`${kind}-timeout`, undefined, AbortSignal.timeout(20));
            const sampled = createOutboundObserver({
              collectorOrigin: collector.origin,
              providerOrigin: provider.origin,
              ingestionToken: f.key.token,
              integration,
              sampleRate: 0,
            });
            provider.setMode("base");
            try {
              await (
                await sampled.fetch(
                  provider.origin + operation.path,
                  { method: "POST" },
                  { operation },
                )
              ).text();
              await sampled.flush();
            } finally {
              sampled.close();
            }
          } finally {
            observer.close();
            await stopServer(provider.server);
          }
        }
      } finally {
        await stopServer(collector.server);
      }
      const config = path.resolve(`.tsconfig-observe-${randomUUID()}.json`);
      const tsconfig = JSON.parse(await readFile("tsconfig.json", "utf8"));
      tsconfig.compilerOptions.incremental = false;
      await writeFile(config, JSON.stringify(tsconfig));
      const out = await open(path.join(dir, "stdout.log"), "wx"),
        err = await open(path.join(dir, "stderr.log"), "wx");
      const child = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "3004",
        ],
        {
          windowsHide: true,
          stdio: ["ignore", out.fd, err.fd],
          env: {
            ...process.env,
            NODE_ENV: "development",
            SPEKTRACE_ACCOUNTS_ENABLED: "false",
            SPEKTRACE_ANNOUNCEMENTS_FILE: path.join(dir,"announcements.json"),
            DATABASE_URL: url.toString(),
            SPEKTRACE_INTERNAL_WORKSPACE_ID: f.workspace.id,
            SPEKTRACE_INTERNAL_API_TOKEN: f.adminToken,
            SPEKTRACE_REDIS_PREFIX: `observe-review-${randomUUID()}`,
            SPEKTRACE_NEXT_DIST_DIR: `.next-observe-review-${randomUUID()}`,
            SPEKTRACE_NEXT_TSCONFIG: path
              .relative(process.cwd(), config)
              .replaceAll("\\", "/"),
            SPEKTRACE_AI_INVESTIGATION_ENABLED: "false",
            SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED: "false",
            SPEKTRACE_STRIPE_TEST_ENABLED: "false",
          },
        },
      );
      await writeFile(path.join(dir, "control.json"), "{}");
      await writeFile(
        path.join(dir, "ready.json"),
        JSON.stringify(
          {
            baseUrl: "http://127.0.0.1:3004/dashboard/observations",
            observations,
            syntheticOnly: true,
            disposable: true,
            expiresAfterMinutes: 15,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          reviewDirectory: dir,
          baseUrl: "http://127.0.0.1:3004/dashboard/observations",
          syntheticOnly: true,
        }),
      );
      try {
        const deadline = Date.now() + 15 * 60000;
        while (!stop && child.exitCode === null && Date.now() < deadline) {
          const control = JSON.parse(
            await readFile(path.join(dir, "control.json"), "utf8").catch(
              () => "{}",
            ),
          ) as { stop?: boolean };
          if (control.stop) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        if (child.exitCode === null) {
          const ended = once(child, "exit");
          child.kill();
          await ended;
        }
        await out.close();
        await err.close();
        await rm(config, { force: true });
      }
    } finally {
      await db.$disconnect();
    }
  } finally {
    try {
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
}
main().catch(() => {
  console.error(
    "Disposable observability review failed; connection values withheld.",
  );
  process.exitCode = 1;
});
