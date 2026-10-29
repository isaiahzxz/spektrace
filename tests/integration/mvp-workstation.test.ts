import { loadWorkspaceOverview } from "@/server/dashboard/workspace-overview";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { createOutboundObserver } from "@/lib/integration-observations/outbound-fetch";
import {
  observationSchema,
  digest,
} from "@/lib/integration-observations/contract";
import { ingestIntegrationEvent } from "@/server/integration-observations/ingest";
import { manageResponseBaseline } from "@/server/integration-observations/baselines";
import {
  listObservations,
  loadObservation,
} from "@/server/dashboard/integration-observations";
import {
  loadIntegrationDirectory,
  loadIntegrationContext,
} from "@/server/dashboard/integrations";
import { observationEmptyState } from "@/lib/dashboard/observation-query";
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
  throw Error("Use disposable MVP verifier");
const db = createPrismaClientForUrl(url);
afterAll(() => db.$disconnect());
async function captured() {
  const f = await observabilityFixture(db),
    collector = await startCollector(db),
    provider = await startProvider("payments");
  const integration = {
    key: "synthetic-payments",
    provider: "fixture-payments",
    environment: "test",
  };
  const observer = createOutboundObserver({
    collectorOrigin: collector.origin,
    providerOrigin: provider.origin,
    ingestionToken: f.key.token,
    integration,
    responsePointers: ["/amount"],
  });
  await (
    await observer.fetch(
      provider.origin + "/payments",
      { method: "POST" },
      { operation: { method: "POST", path: "/payments" } },
    )
  ).text();
  expect((await observer.flush()).coverageDelivered).toBe(true);
  await drainIntegrationWork(db, f.workspace.id);
  const row = await db.integrationObservation.findFirstOrThrow({
    where: { workspaceId: f.workspace.id },
  });
  return {
    ...f,
    integration,
    row,
    async close() {
      observer.close();
      await stopServer(collector.server);
      await stopServer(provider.server);
    },
  };
}
describe("MVP integration workstation read paths", () => {
  it("distinguishes request contracts from configured outbound scopes and awaits capture after baseline configuration", async () => {
    const f = await observabilityFixture(db);
    await requestSpec(db, f.workspace.id);
    let directory = await loadIntegrationDirectory(db, f.workspace.id);
    expect(directory.integrations).toEqual([]);
    expect(directory.contracts).toHaveLength(1);
    expect(directory.credentialCount).toBe(1);
    const spec = await db.apiSpec.findFirstOrThrow({
      where: { workspaceId: f.workspace.id },
    });
    await manageResponseBaseline(db, f.workspace.id, {
      action: "contract",
      integration: {
        key: "synthetic-payments",
        provider: "fixture-payments",
        environment: "test",
      },
      operation: { method: "POST", path: "/payments" },
      apiSpecId: spec.id,
      sourceSha256: spec.sourceSha256,
      statusCode: 200,
      pointers: ["/amount"],
    });
    directory = await loadIntegrationDirectory(db, f.workspace.id);
    expect(directory.integrations).toMatchObject([
      { calls: 0, state: "Awaiting first observation", baselineCount: 1 },
    ]);
    const observations = await listObservations(db, f.workspace.id, {
      page: 1,
      svc: "synthetic-payments",
    });
    expect(
      observationEmptyState(
        { ...observations, coverageCount: observations.coverage.length },
        { page: 1, svc: "synthetic-payments" },
      ),
    ).toBe("waiting");
    expect(
      (await loadIntegrationContext(db, f.workspace.id, "synthetic-payments"))
        ?.baselines[0],
    ).toMatchObject({ origin: "CONTRACT", active: false, version: 1 });
  });
  it("uses real capture status, tenant/provider/environment boundaries, and pinned baseline context", async () => {
    const f = await captured();
    try {
      const directory = await loadIntegrationDirectory(db, f.workspace.id);
      expect(directory.integrations).toMatchObject([
        { identity: f.integration, calls: 1, state: "Calls received" },
      ]);
      expect(directory.integrations[0].coverageReportedAt).not.toBeNull();
      const b = await manageResponseBaseline(db, f.workspace.id, {
        action: "observe",
        observationId: f.row.id,
      });
      const context = await loadIntegrationContext(
        db,
        f.workspace.id,
        f.integration.key,
        { env: "test", provider: f.integration.provider },
      );
      expect(context?.baselines).toMatchObject([
        {
          id: b.id,
          origin: "OBSERVED",
          active: false,
          fields: [{ pointer: "/amount", type: "integer" }],
        },
      ]);
      expect(
        (await loadIntegrationDirectory(db, randomUUID())).integrations,
      ).toEqual([]);
      expect(
        (await loadIntegrationContext(db, randomUUID(), f.integration.key))
          ?.baselines,
      ).toEqual([]);
      expect(
        (
          await loadIntegrationDirectory(db, f.workspace.id, {
            provider: "other",
          })
        ).integrations,
      ).toEqual([]);
      expect(
        (
          await loadIntegrationDirectory(db, f.workspace.id, {
            env: "production",
          })
        ).integrations,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("filters exact UTC received boundaries and keeps cumulative coverage independent of call dates", async () => {
    const f = await captured();
    try {
      const original = observationSchema.parse(f.row.envelope);
      for (const time of [
        "2026-05-10T00:00:00.000Z",
        "2026-05-10T23:59:59.999Z",
        "2026-05-11T00:00:00.000Z",
      ]) {
        const event = {
          ...original,
          sourceEventId: randomUUID(),
          callId: randomUUID(),
        };
        const { sourceEventId, ...content } = event;
        await db.integrationObservation.create({
          data: {
            workspaceId: f.workspace.id,
            collectorCredentialId: f.key.credential.id,
            sourceEventId,
            callId: event.callId,
            attempt: 1,
            integrationKey: event.integration.key,
            providerKey: event.integration.provider,
            environment: event.integration.environment,
            httpMethod: event.operation.method,
            operationPath: event.operation.path,
            resultKind: "HTTP",
            statusCode: 200,
            durationMs: 1,
            scopeKey: f.row.scopeKey,
            envelope: event,
            payloadDigest: digest(content),
            occurredAt: new Date(event.occurredAt),
            receivedAt: new Date(time),
          },
        });
      }
      const rows = await listObservations(db, f.workspace.id, {
        page: 1,
        svc: f.integration.key,
        provider: f.integration.provider,
        env: "test",
        from: "2026-05-10",
        to: "2026-05-10",
      });
      expect(rows.total).toBe(2);
      expect(rows.rows.map((row) => row.receivedAt).sort()).toEqual([
        "2026-05-10T00:00:00.000Z",
        "2026-05-10T23:59:59.999Z",
      ]);
      expect(rows.coverage).toHaveLength(1);
      expect(
        (
          await listObservations(db, randomUUID(), {
            page: 1,
            from: "2026-05-10",
            to: "2026-05-10",
          })
        ).total,
      ).toBe(0);
      expect(
        (
          await listObservations(db, f.workspace.id, {
            page: 1,
            finding: "contract",
          })
        ).total,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("shows retained processing/delivery gaps without a healthy-zero verdict", async () => {
    const f = await captured();
    try {
      const event = observationSchema.parse(f.row.envelope);
      const queued = await ingestIntegrationEvent(db, f.key.token, {
        ...event,
        sourceEventId: randomUUID(),
        callId: randomUUID(),
      });
      await db.outboxEvent.updateMany({
        where: { integrationObservationId: queued.id },
        data: { dispatchStatus: "FAILED", lastError: "SYNTHETIC_DELIVERY_GAP" },
      });
      expect(
        (await loadIntegrationDirectory(db, f.workspace.id)).integrations[0]
          .state,
      ).toBe("Processing delayed");
      expect(
        (await loadObservation(db, f.workspace.id, queued.id))?.state,
      ).toBe("PROCESSING_DELAYED");
      expect(
        (await listObservations(db, f.workspace.id, { page: 1 })).rows.find(
          (row) => row.id === queued.id,
        )?.state,
      ).toBe("PROCESSING_DELAYED");
      expect(
        (
          await db.integrationObservation.findUniqueOrThrow({
            where: { id: queued.id },
          })
        ).processingState,
      ).toBe("PENDING");
    } finally {
      await f.close();
    }
  });
  it('keeps overview counts inside the workspace and explicit 24-hour received window',async()=>{const f=await captured();try{const now=new Date(f.row.receivedAt.getTime()+1000),other=await observabilityFixture(db);let overview=await loadWorkspaceOverview(db,f.workspace.id,now);expect(overview.calls).toBe(1);expect(overview.directory.integrations[0].identity).toEqual(f.integration);const foreign=await loadWorkspaceOverview(db,other.workspace.id,now);expect(foreign.calls).toBe(0);expect(foreign.recent.rows.some(r=>r.id===f.row.id)).toBe(false);expect(foreign.directory.integrations).toEqual([]);overview=await loadWorkspaceOverview(db,f.workspace.id,new Date(now.getTime()+25*60*60*1000));expect(overview.calls).toBe(0);expect(overview.recent.rows).toHaveLength(1);expect((await loadWorkspaceOverview(db,f.workspace.id,new Date(f.row.receivedAt.getTime()-1000))).calls).toBe(0);}finally{await f.close();}});
  it('surfaces validated drift findings with the call investigation link identity',async()=>{const f=await captured();try{const baseline=await manageResponseBaseline(db,f.workspace.id,{action:'observe',observationId:f.row.id});await manageResponseBaseline(db,f.workspace.id,{action:'activate',baselineId:baseline.id});const event=observationSchema.parse(f.row.envelope);if(!event.capture.projection)throw Error('Capture fixture required');const drift=await ingestIntegrationEvent(db,f.key.token,{...event,callId:randomUUID(),sourceEventId:randomUUID(),capture:{...event.capture,projection:{...event.capture.projection,fields:[{pointer:'/amount',presence:'present',type:'string'}]}}});await drainIntegrationWork(db,f.workspace.id);const overview=await loadWorkspaceOverview(db,f.workspace.id);expect(overview.drift).toBe(1);expect(overview.contract).toBe(0);expect(overview.findings.map(r=>({id:r.id,state:r.state}))).toEqual([{id:drift.id,state:'DRIFT'}]);expect(overview.linkedFailed).toBe(0);}finally{await f.close();}});

});
