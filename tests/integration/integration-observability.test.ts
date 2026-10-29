import { Worker } from "bullmq";
import { dispatchOutboxBatch } from "@/server/outbox/dispatcher";
import {
  getIncidentQueue,
  resetIncidentQueueForTests,
} from "@/lib/queue/incident-queue";
import { disconnectRedis, getWorkerRedis } from "@/lib/redis";
import {
  getIncidentQueueName,
  type IncidentJobPayload,
} from "@/lib/queue/job-types";
import { routeWorkerJob } from "@/server/services/route-worker-job";
import { reconcileIntegrationOutbox } from "@/server/integration-observations/reconcile";
import {
  loadObservation,
  listObservations,
} from "@/server/dashboard/integration-observations";
import { submitIncidentWithIngestionToken } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { createOutboundObserver } from "@/lib/integration-observations/outbound-fetch";
import { observationSchema } from "@/lib/integration-observations/contract";
import { manageResponseBaseline } from "@/server/integration-observations/baselines";
import {
  ingestIntegrationEvent,
  ingestWorkflowOutcome,
} from "@/server/integration-observations/ingest";
import { revokeIngestionCredential } from "@/server/services/ingestion-credentials";
import {
  observabilityFixture,
  startCollector,
  startProvider,
  stopServer,
  drainIntegrationWork,
  requestSpec,
} from "../../scripts/lib/integration-observability-fixture";
const url = requireTestDatabaseUrl();
if (
  new URL(url).pathname.slice(1) !==
    process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(
    process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? "",
  )
)
  throw Error("Use disposable observability verifier");
const db = createPrismaClientForUrl(url);
process.env.SPEKTRACE_REDIS_PREFIX = `observe-test-${randomUUID()}`;
afterAll(async () => {
  vi.unstubAllEnvs();
  await resetIncidentQueueForTests();
  await disconnectRedis();
  await db.$disconnect();
});
const results: {
  id: string;
  status: "matched";
  evidence: Record<string, unknown>;
}[] = [];
async function checked(id: string, evidence: Record<string, unknown>) {
  results.push({ id, status: "matched", evidence });
  const dir = process.env.SPEKTRACE_OBSERVABILITY_REPORT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "cases.json"),
      JSON.stringify(
        { syntheticOnly: true, realIntegrations: [], cases: results },
        null,
        2,
      ),
    );
  }
}
async function setup(kind: "payments" | "crm" = "payments") {
  const f = await observabilityFixture(db),
    collector = await startCollector(db),
    provider = await startProvider(kind);
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
      kind === "payments" ? ["/amount", "/status"] : ["/count", "/results"],
    providerVersionHeader: "x-api-version",
  });
  const operation = {
    method: "POST" as const,
    path: kind === "payments" ? "/payments" : "/contacts",
  };
  async function call(
    correlation?: { kind: "workflow"; id: string; attempt: number },
    signal?: AbortSignal,
    requestIncidentId?: string,
  ) {
    const callId = randomUUID();
    try {
      await (
        await observer.fetch(
          `${provider.origin}${operation.path}`,
          { method: "POST", signal },
          { operation, callId, correlation, requestIncidentId },
        )
      ).text();
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
    expect((await observer.flush()).coverageDelivered).toBe(true);
    await drainIntegrationWork(db, f.workspace.id);
    return db.integrationObservation.findFirstOrThrow({
      where: { workspaceId: f.workspace.id, callId },
    });
  }
  async function baseline(id: string) {
    const b = await manageResponseBaseline(db, f.workspace.id, {
      action: "observe",
      observationId: id,
    });
    expect(b.active).toBe(false);
    await manageResponseBaseline(db, f.workspace.id, {
      action: "activate",
      baselineId: b.id,
    });
    return b;
  }
  return {
    ...f,
    collector,
    provider,
    observer,
    integration,
    operation,
    call,
    baseline,
    async close() {
      observer.close();
      await stopServer(provider.server);
      await stopServer(collector.server);
    },
  };
}
describe("synthetic integration observability acceptance", () => {
  it("enforces the link fan-out cap across late calls and outcome processing", async () => {
    const f = await setup();
    try {
      const event = observationSchema.parse((await f.call()).envelope),
        correlation = {
          kind: "workflow" as const,
          id: randomUUID(),
          attempt: 1,
        };
      const ids: string[] = [];
      for (let index = 0; index < 101; index++) {
        const created = await ingestIntegrationEvent(db, f.key.token, {
          ...event,
          sourceEventId: randomUUID(),
          callId: randomUUID(),
          correlation,
        });
        ids.push(created.id);
      }
      const outcome = await ingestWorkflowOutcome(db, f.key.token, {
        version: 1,
        sourceEventId: randomUUID(),
        integration: f.integration,
        correlation,
        outcome: "FAILED",
        occurredAt: new Date().toISOString(),
      });
      await routeWorkerJob(db, {
        task: "link-integration-outcome",
        workspaceId: f.workspace.id,
        integrationOutcomeId: outcome.id,
      });
      expect(
        await db.integrationOutcomeLink.count({
          where: { outcomeId: outcome.id },
        }),
      ).toBe(100);
      await drainIntegrationWork(db, f.workspace.id);
      expect(
        await db.integrationOutcomeLink.count({
          where: { outcomeId: outcome.id },
        }),
      ).toBe(100);
      expect(
        (await listObservations(db, f.workspace.id, { page: 1 }))
          .truncatedOutcomes,
      ).toBe(1);
      expect(
        (await loadObservation(db, f.workspace.id, ids[100]))?.linksTruncated,
      ).toBe(true);
      expect(
        (await loadObservation(db, f.workspace.id, ids[0]))?.linksTruncated,
      ).toBe(true);
    } finally {
      await f.close();
    }
  }, 20000);

  it("uses latest-per-instance coverage without summing old snapshots, and shows missing calls", async () => {
    const f = await setup();
    try {
      await f.call();
      await f.call();
      let list = await listObservations(db, f.workspace.id, { page: 1 });
      expect(list.coverage).toHaveLength(1);
      expect(list.coverage[0].counters.seen).toBe(2);
      const sampled = createOutboundObserver({
        collectorOrigin: f.collector.origin,
        providerOrigin: f.provider.origin,
        ingestionToken: f.key.token,
        integration: f.integration,
        sampleRate: 0,
      });
      try {
        await (
          await sampled.fetch(
            f.provider.origin + "/payments",
            { method: "POST" },
            { operation: f.operation },
          )
        ).text();
        await sampled.flush();
      } finally {
        sampled.close();
      }
      list = await listObservations(db, f.workspace.id, { page: 1 });
      expect(list.total).toBe(2);
      expect(
        list.coverage.reduce((sum, row) => sum + row.counters.seen, 0),
      ).toBe(3);
      expect(
        list.coverage.reduce((sum, row) => sum + row.counters.unsampled, 0),
      ).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("rolls back acceptance when durable work cannot be stored", async () => {
    const f = await setup();
    try {
      const row = await f.call(),
        event = observationSchema.parse(row.envelope);
      const before = await db.auditLog.count({
        where: { workspaceId: f.workspace.id },
      });
      await db.$executeRawUnsafe(
        "ALTER TABLE outbox_events ADD CONSTRAINT observe_rollback_test CHECK (workspace_id <> " +
          "'" +
          f.workspace.id +
          "'" +
          "::uuid) NOT VALID",
      );
      try {
        const response = await fetch(
          f.collector.origin + "/api/internal/integration-observations",
          {
            method: "POST",
            headers: {
              authorization: "Bearer " + f.key.token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              ...event,
              sourceEventId: randomUUID(),
              callId: randomUUID(),
            }),
          },
        );
        expect(response.status).toBe(503);
        expect(
          await db.integrationObservation.count({
            where: { workspaceId: f.workspace.id },
          }),
        ).toBe(1);
        expect(
          await db.auditLog.count({ where: { workspaceId: f.workspace.id } }),
        ).toBe(before);
      } finally {
        await db.$executeRawUnsafe(
          "ALTER TABLE outbox_events DROP CONSTRAINT observe_rollback_test",
        );
      }
    } finally {
      await f.close();
    }
  });
  it("withholds cross-workspace reads and inconsistent detector evidence", async () => {
    const f = await setup();
    try {
      const sample = await f.call();
      await f.baseline(sample.id);
      f.provider.setMode("drift");
      const row = await f.call();
      expect(
        (await loadObservation(db, f.workspace.id, row.id))?.evidence?.code,
      ).toBe("DRIFT");
      expect(await loadObservation(db, randomUUID(), row.id)).toBe(null);
      expect(
        (await listObservations(db, randomUUID(), { page: 1 })).total,
      ).toBe(0);
      await db.integrationObservation.update({
        where: { id: row.id },
        data: {
          detectorEvidence: {
            version: 1,
            code: "MATCH",
            baseline: null,
            changes: [],
            scope: "selected_fields_only",
            causationEstablished: false,
          },
        },
      });
      expect(await loadObservation(db, f.workspace.id, row.id)).toMatchObject({
        state: "Incomplete",
        evidence: null,
      });
    } finally {
      await f.close();
    }
  });
  it("recovers a lost queue job and routes observation and outcome tasks through Redis", async () => {
    const f = await setup();
    try {
      const source = observationSchema.parse((await f.call()).envelope);
      const correlation = {
        kind: "workflow" as const,
        id: randomUUID(),
        attempt: 1,
      };
      const observation = await ingestIntegrationEvent(db, f.key.token, {
        ...source,
        sourceEventId: randomUUID(),
        callId: randomUUID(),
        correlation,
      });
      const outcome = await ingestWorkflowOutcome(db, f.key.token, {
        version: 1,
        sourceEventId: randomUUID(),
        integration: f.integration,
        correlation,
        outcome: "FAILED",
        occurredAt: new Date().toISOString(),
      });
      await dispatchOutboxBatch(db, { workspaceId: f.workspace.id });
      const event = await db.outboxEvent.findFirstOrThrow({
        where: { integrationObservationId: observation.id },
      });
      const lost = await getIncidentQueue().getJob(event.id);
      expect(lost?.data.task).toBe("observe-integration");
      await lost?.remove();
      await db.outboxEvent.update({
        where: { id: event.id },
        data: { publishedAt: new Date(Date.now() - 60000) },
      });
      expect(await reconcileIntegrationOutbox(db)).toBe(1);
      const worker = new Worker<IncidentJobPayload>(
        getIncidentQueueName(),
        (job) => routeWorkerJob(db, job.data),
        { connection: getWorkerRedis() },
      );
      try {
        await worker.waitUntilReady();
        await dispatchOutboxBatch(db, { workspaceId: f.workspace.id });
        const deadline = Date.now() + 5000;
        while (
          Date.now() < deadline &&
          ((await db.integrationOutcomeLink.count({
            where: { observationId: observation.id, outcomeId: outcome.id },
          })) === 0 ||
            (
              await db.integrationObservation.findUniqueOrThrow({
                where: { id: observation.id },
              })
            ).processingState !== "DONE")
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
        expect(
          await db.integrationOutcomeLink.count({
            where: { observationId: observation.id, outcomeId: outcome.id },
          }),
        ).toBe(1);
        expect(
          (
            await db.integrationObservation.findUniqueOrThrow({
              where: { id: observation.id },
            })
          ).processingState,
        ).toBe("DONE");
      } finally {
        await worker.close();
        await getIncidentQueue().obliterate({ force: true });
      }
    } finally {
      await f.close();
    }
  }, 15000);

  it("detects payment and CRM response changes at HTTP 200 and pins immutable observed revisions", async () => {
    for (const kind of ["payments", "crm"] as const) {
      const f = await setup(kind);
      try {
        const initial = await f.call();
        expect(initial.detectorEvidence).toMatchObject({
          code: "NO_BASELINE",
          causationEstablished: false,
        });
        const b = await f.baseline(initial.id);
        f.provider.setMode("drift");
        const changed = await f.call();
        expect(changed.baselineId, "baselineId acceptance pin").toBe(b.id);
        expect(changed).toMatchObject({
          statusCode: 200,
          baselineId: b.id,
          processingState: "DONE",
        });
        expect(changed.detectorEvidence).toMatchObject({
          code: "DRIFT",
          baseline: { origin: "OBSERVED", version: 1 },
          causationEstablished: false,
        });
        expect(changed.driftSignature).toMatch(/^[a-f0-9]{64}$/);
        const newer = await f.baseline(changed.id);
        expect(newer.id).not.toBe(b.id);
        expect(
          (
            await db.integrationObservation.findUniqueOrThrow({
              where: { id: changed.id },
            })
          ).baselineId,
        ).toBe(b.id);
        await expect(
          db.integrationObservation.update({
            where: { id: changed.id },
            data: { statusCode: 400 },
          }),
        ).rejects.toThrow();
        await checked(`200-drift-${kind}`, {
          httpStatus: 200,
          code: "DRIFT",
          baselineOrigin: "OBSERVED",
          revisionPinned: true,
        });
      } finally {
        await f.close();
      }
    }
  }, 15000);
  it("separates timeout, successful downstream outcome, late failure, retry and unmatched outcomes", async () => {
    const f = await setup();
    try {
      await f.baseline((await f.call()).id);
      f.provider.setMode("timeout");
      const timed = await f.call(undefined, AbortSignal.timeout(20));
      expect(timed.detectorEvidence).toMatchObject({
        code: "NO_RESPONSE",
        changes: [],
      });
      await checked("timeout-no-drift", {
        result: timed.resultKind,
        drift: false,
      });
      f.provider.setMode("drift");
      const correlation = {
        kind: "workflow" as const,
        id: randomUUID(),
        attempt: 1,
      };
      const drift = await f.call(correlation);
      expect(drift.detectorEvidence).toMatchObject({ code: "DRIFT" });
      expect(
        await db.integrationOutcomeLink.count({
          where: { observationId: drift.id },
        }),
      ).toBe(0);
      expect(
        await f.observer.outcome({ correlation, outcome: "SUCCEEDED" }),
      ).toBe(true);
      await drainIntegrationWork(db, f.workspace.id);
      expect(
        await db.integrationOutcomeLink.count({
          where: { observationId: drift.id },
        }),
      ).toBe(1);
      await checked("drift-no-failure", {
        drift: true,
        reportedOutcome: "SUCCEEDED",
        causationEstablished: false,
      });
      const late = { ...correlation, id: randomUUID() },
        earlier = await f.call(late);
      const delayed = {
        version: 1 as const,
        sourceEventId: randomUUID(),
        integration: f.integration,
        correlation: late,
        outcome: "FAILED" as const,
        occurredAt: new Date(Date.now() + 100).toISOString(),
      };
      const first = await ingestWorkflowOutcome(db, f.key.token, delayed);
      await drainIntegrationWork(db, f.workspace.id);
      expect(
        await db.integrationOutcomeLink.count({
          where: { observationId: earlier.id, outcomeId: first.id },
        }),
      ).toBe(1);
      await checked("delayed-outcome", {
        explicitIdentityMatched: true,
        outcome: "FAILED",
        causationEstablished: false,
      });
      const before = await db.auditLog.count({
        where: { workspaceId: f.workspace.id },
      });
      expect(
        await ingestWorkflowOutcome(db, f.key.token, delayed),
      ).toMatchObject({ id: first.id, created: false });
      expect(
        await db.auditLog.count({ where: { workspaceId: f.workspace.id } }),
      ).toBe(before);
      await expect(
        ingestWorkflowOutcome(db, f.key.token, {
          ...delayed,
          outcome: "SUCCEEDED",
        }),
      ).rejects.toThrow();
      const event = observationSchema.parse(earlier.envelope);
      expect(
        await ingestIntegrationEvent(db, f.key.token, event),
      ).toMatchObject({ id: earlier.id, created: false });
      expect(
        await ingestIntegrationEvent(db, f.key.token, {
          ...event,
          sourceEventId: randomUUID(),
        }),
      ).toMatchObject({ id: earlier.id, created: false });
      const retry = await ingestIntegrationEvent(db, f.key.token, {
        ...event,
        sourceEventId: randomUUID(),
        attempt: 2,
        correlation: { ...late, attempt: 2 },
      });
      expect(retry.created).toBe(true);
      await ingestWorkflowOutcome(db, f.key.token, {
        ...delayed,
        sourceEventId: randomUUID(),
        correlation: { ...late, attempt: 2 },
        outcome: "SUCCEEDED",
      });
      const unmatched = await ingestWorkflowOutcome(db, f.key.token, {
        ...delayed,
        sourceEventId: randomUUID(),
        correlation: { ...late, id: randomUUID() },
      });
      await drainIntegrationWork(db, f.workspace.id);
      expect(
        await db.integrationOutcomeLink.count({
          where: { outcomeId: unmatched.id },
        }),
      ).toBe(0);
      await expect(
        db.integrationOutcomeLink.create({
          data: {
            workspaceId: f.workspace.id,
            observationId: earlier.id,
            outcomeId: unmatched.id,
          },
        }),
      ).rejects.toThrow();
      expect(
        await db.integrationOutcomeLink.count({
          where: { observationId: retry.id, outcomeId: first.id },
        }),
      ).toBe(0);
      await checked("dedupe-retries", {
        duplicateCreates: false,
        retryDistinct: true,
        previousFailureUnchanged: true,
      });
      await checked("coverage-unmatched", {
        unmatchedOutcomes: 1,
        coverageReports: await db.integrationCoverage.count({
          where: { workspaceId: f.workspace.id },
        }),
        countsAreInstrumentedOnly: true,
      });
    } finally {
      await f.close();
    }
  }, 15000);
  it("retains the existing deterministic request mismatch detector", async () => {
    const f = await setup();
    try {
      await requestSpec(db, f.workspace.id);
      const accepted = await submitIncidentWithIngestionToken(db, f.key.token, {
        apiKey: f.integration.key,
        environment: "test",
        source: "WEBHOOK",
        sourceEventId: randomUUID(),
        httpMethod: "POST",
        requestPath: "/payments",
        statusCode: 400,
        occurredAt: new Date().toISOString(),
        sanitizedRequestBody: { amount: "100" },
      });
      await processIncidentValidation(db, f.workspace.id, accepted.incident.id);
      expect(
        (
          await db.incident.findUniqueOrThrow({
            where: { id: accepted.incident.id },
          })
        ).validationStatus,
      ).toBe("MISMATCH");
      const call = await f.call(undefined, undefined, accepted.incident.id);
      expect(call.requestIncidentId).toBe(accepted.incident.id);
      await checked("request-mismatch", {
        validationStatus: "MISMATCH",
        requestLink: "integration-reported",
        outboundPayloadIdentityProven: false,
      });
    } finally {
      await f.close();
    }
  });
  it("uses a stored OpenAPI response contract distinctly from an observed baseline", async () => {
    const f = await setup();
    try {
      const spec = await requestSpec(db, f.workspace.id);
      vi.stubEnv("SPEKTRACE_INTERNAL_API_TOKEN", f.adminToken);
      vi.stubEnv("SPEKTRACE_INTERNAL_WORKSPACE_ID", f.workspace.id);
      const command = {
        action: "contract",
        integration: f.integration,
        operation: f.operation,
        apiSpecId: spec.id,
        sourceSha256: spec.sourceSha256,
        statusCode: 200,
        pointers: ["/amount", "/status"],
      };
      async function adminPost(body: unknown) {
        return fetch(f.collector.origin + "/api/internal/response-baselines", {
          method: "POST",
          headers: {
            authorization: "Bearer " + f.adminToken,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      }
      const created = await adminPost(command);
      expect(created.status).toBe(201);
      const baseline = await created.json();
      expect(baseline.active).toBe(false);
      expect((await adminPost(command)).status).toBe(200);
      expect(
        (await adminPost({ action: "activate", baselineId: baseline.id }))
          .status,
      ).toBe(200);
      expect((await f.call()).detectorEvidence).toMatchObject({
        code: "MATCH",
        baseline: { origin: "CONTRACT" },
      });
      f.provider.setMode("drift");
      expect((await f.call()).detectorEvidence).toMatchObject({
        code: "CONTRACT_MISMATCH",
        baseline: { origin: "CONTRACT" },
      });
    } finally {
      await f.close();
    }
  });
  it("enforces credential boundaries, private projection, final-attempt integrity and no AI side effects", async () => {
    const f = await setup();
    try {
      const row = await f.call();
      const other = await observabilityFixture(db);
      const envelope = observationSchema.parse(row.envelope);
      const copied = await ingestIntegrationEvent(
        db,
        other.key.token,
        envelope,
      );
      expect(copied.created).toBe(true);
      expect(
        (
          await db.integrationObservation.findUniqueOrThrow({
            where: { id: copied.id },
          })
        ).workspaceId,
      ).toBe(other.workspace.id);
      await expect(
        manageResponseBaseline(db, other.workspace.id, {
          action: "observe",
          observationId: row.id,
        }),
      ).rejects.toThrow();
      await expect(
        ingestIntegrationEvent(db, other.key.token, {
          ...envelope,
          sourceEventId: randomUUID(),
          callId: randomUUID(),
          requestIncidentId: randomUUID(),
        }),
      ).rejects.toThrow();
      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${f.adminToken}`,
      };
      expect(
        (
          await fetch(
            `${f.collector.origin}/api/internal/integration-observations`,
            { method: "POST", headers, body: JSON.stringify(envelope) },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${f.collector.origin}/api/internal/response-baselines`, {
            method: "POST",
            headers: { ...headers, authorization: `Bearer ${f.key.token}` },
            body: JSON.stringify({ action: "observe", observationId: row.id }),
          })
        ).status,
      ).toBe(401);
      const retained = JSON.stringify({
        observations: await db.integrationObservation.findMany({
          where: { workspaceId: f.workspace.id },
        }),
        coverage: await db.integrationCoverage.findMany({
          where: { workspaceId: f.workspace.id },
        }),
        audit: await db.auditLog.findMany({
          where: { workspaceId: f.workspace.id },
        }),
        jobs: await db.outboxEvent.findMany({
          where: { workspaceId: f.workspace.id },
        }),
      });
      for (const marker of [
        "synthetic-private@example.test",
        "private-customer-id",
        f.key.token,
        f.provider.origin,
      ])
        expect(retained).not.toContain(marker);
      await revokeIngestionCredential(db, f.workspace.id, f.key.credential.id);
      await expect(
        ingestIntegrationEvent(db, f.key.token, envelope),
      ).rejects.toThrow("Unauthorized");
      expect(
        await db.investigationInferenceRun.count({
          where: { workspaceId: f.workspace.id },
        }),
      ).toBe(0);
      expect(
        (row.detectorEvidence as { causationEstablished: boolean })
          .causationEstablished,
      ).toBe(false);
      await checked("privacy-isolation", {
        crossWorkspaceReferencesRejected: true,
        valuesRetained: false,
        revokedCredentialRejected: true,
      });
      await checked("deterministic-ai", {
        inferenceRuns: 0,
        causationEstablished: false,
      });
    } finally {
      await f.close();
    }
  });
});
