import "server-only";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  identitySchema,
  baselineShapeSchema,
  labelSchema,
  coverageSchema,
} from "@/lib/integration-observations/contract";
import { z } from "zod";
export const integrationScopeSchema = z.object({
  svc: labelSchema.optional(),
  provider: labelSchema.optional(),
  env: labelSchema.optional(),
});
export type IntegrationScope = z.infer<typeof integrationScopeSchema>;
export function integrationHref(
  key: string,
  provider?: string,
  environment?: string,
) {
  const query = new URLSearchParams();
  if (provider) query.set("provider", provider);
  if (environment) query.set("env", environment);
  return (
    "/dashboard/integrations/" +
    encodeURIComponent(key) +
    (query.size ? "?" + query : "")
  );
}
export async function loadIntegrationDirectory(
  db: PrismaClient,
  workspaceId: string,
  scope: IntegrationScope = {},
) {
  const known = await db.$queryRaw<
    {
      integration_key: string;
      provider_key: string;
      environment: string;
      total: bigint;
      last_received: Date | null;
      processing_state: string | null;
      processing_issue: boolean;
      planned_configured:boolean|null;
      baseline_count: bigint;
      coverage: unknown;
    }[]
  >(Prisma.sql`
 SELECT k.integration_key,k.provider_key,k.environment,(SELECT p.configured FROM planned_integrations p WHERE p.workspace_id=${workspaceId}::uuid AND p.integration_key=k.integration_key AND p.provider_key=k.provider_key AND p.environment=k.environment) AS planned_configured,counts.total,latest.received_at AS last_received,latest.processing_state,
 EXISTS(SELECT 1 FROM outbox_events e WHERE e.workspace_id=${workspaceId}::uuid AND e.integration_observation_id=latest.id AND (e.dispatch_status::text='FAILED' OR e.last_error IS NOT NULL)) AS processing_issue,
 (SELECT count(*) FROM integration_response_baselines b WHERE b.workspace_id=${workspaceId}::uuid AND b.integration_key=k.integration_key AND b.provider_key=k.provider_key AND b.environment=k.environment) AS baseline_count,
 report.envelope AS coverage
 FROM (SELECT integration_key,provider_key,environment FROM planned_integrations WHERE workspace_id=${workspaceId}::uuid
 UNION SELECT integration_key,provider_key,environment FROM integration_observations WHERE workspace_id=${workspaceId}::uuid
 UNION SELECT integration_key,provider_key,environment FROM integration_response_baselines WHERE workspace_id=${workspaceId}::uuid
 UNION SELECT integration_key,provider_key,environment FROM integration_capture_coverage WHERE workspace_id=${workspaceId}::uuid) k
 CROSS JOIN LATERAL (SELECT count(*) AS total FROM integration_observations o WHERE o.workspace_id=${workspaceId}::uuid AND o.integration_key=k.integration_key AND o.provider_key=k.provider_key AND o.environment=k.environment) counts
 LEFT JOIN LATERAL (SELECT o.id,o.received_at,o.processing_state FROM integration_observations o WHERE o.workspace_id=${workspaceId}::uuid AND o.integration_key=k.integration_key AND o.provider_key=k.provider_key AND o.environment=k.environment ORDER BY o.received_at DESC,o.id DESC LIMIT 1) latest ON true
 LEFT JOIN LATERAL (SELECT envelope FROM (SELECT DISTINCT ON(instance_id) envelope,received_at FROM integration_capture_coverage c WHERE c.workspace_id=${workspaceId}::uuid AND c.integration_key=k.integration_key AND c.provider_key=k.provider_key AND c.environment=k.environment ORDER BY instance_id,sequence DESC) reports ORDER BY received_at DESC LIMIT 1) report ON true
 WHERE true ${scope.svc ? Prisma.sql`AND k.integration_key=${scope.svc}` : Prisma.empty} ${scope.env ? Prisma.sql`AND k.environment=${scope.env}` : Prisma.empty} ${scope.provider ? Prisma.sql`AND k.provider_key=${scope.provider}` : Prisma.empty}
 ORDER BY k.integration_key,k.provider_key,k.environment LIMIT 101`);
  const contracts = await db.$queryRaw<
    {
      id: string;
      api_key: string;
      environment: string;
      name: string;
      version: string;
    }[]
  >(
    Prisma.sql`SELECT * FROM (SELECT DISTINCT ON(api_key,environment) id,api_key,environment,name,version FROM api_specs WHERE workspace_id=${workspaceId}::uuid ${scope.svc ? Prisma.sql`AND api_key=${scope.svc}` : Prisma.empty} ${scope.env ? Prisma.sql`AND environment=${scope.env}` : Prisma.empty} ORDER BY api_key,environment,created_at DESC,id DESC) revisions ORDER BY api_key,environment LIMIT 101`,
  );
  const [credentialCount, webhooks, stripe] = await Promise.all([
    db.ingestionCredential.count({
      where: { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
    db.webhookReceipt.count({
      where: {
        workspaceId,
        ...(scope.svc ? { apiKey: scope.svc } : {}),
        ...(scope.env ? { environment: scope.env } : {}),
      },
    }),
    db.stripeWebhookIntegration.count({ where: { workspaceId } }),
  ]);
  const integrations = known.slice(0, 100).flatMap((row) => {
    const identity = identitySchema.safeParse({
      key: row.integration_key,
      provider: row.provider_key,
      environment: row.environment,
    });
    if (!identity.success || !Number.isSafeInteger(Number(row.total)))
      return [];
    const parsed = coverageSchema.safeParse(row.coverage);
    const coverage =
      parsed.success &&
      parsed.data.integration.key === identity.data.key &&
      parsed.data.integration.provider === identity.data.provider &&
      parsed.data.integration.environment === identity.data.environment
        ? parsed.data
        : null;
    const state = row.processing_issue
      ? "Processing delayed"
      : coverage &&
          (coverage.counters.dropped > 0 ||
            coverage.counters.deliveryUnconfirmed > 0)
        ? "Capture gaps reported"
        : Number(row.total) > 0
          ? "Calls received"
          : coverage && coverage.counters.seen > 0
            ? "Calls seen; none retained"
            : row.planned_configured===false?"Setup needed":row.planned_configured===true?"Waiting for first call":"Awaiting first observation";
    return [
      {
        identity: identity.data,
        calls: Number(row.total),
        lastReceived: row.last_received?.toISOString() ?? null,
        state,
        baselineCount: Number(row.baseline_count),
        coverageReportedAt: coverage?.reportedAt ?? null,
      },
    ];
  });
  return {
    integrations,
    scope,
    filtered: Boolean(scope.svc || scope.env || scope.provider),
    truncated: known.length > 100,
    invalidScopes: known.slice(0, 100).length - integrations.length,
    credentialCount,
    webhooks,
    stripe,
    contracts: contracts.slice(0, 100).map((row) => ({
      id: row.id,
      service: row.api_key,
      environment: row.environment,
      name: row.name.slice(0, 200),
      version: row.version.slice(0, 80),
    })),
    contractsTruncated: contracts.length > 100,
  };
}
export async function loadIntegrationContext(
  db: PrismaClient,
  workspaceId: string,
  key: string,
  scope: IntegrationScope = {},
) {
  if (!labelSchema.safeParse(key).success) return null;
  const data = await loadIntegrationDirectory(db, workspaceId, {
    ...scope,
    svc: key,
  });
  const rows = await db.integrationResponseBaseline.findMany({
    where: {
      workspaceId,
      integrationKey: key,
      ...(scope.env ? { environment: scope.env } : {}),
      ...(scope.provider ? { providerKey: scope.provider } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 101,
    select: {
      id: true,
      providerKey: true,
      environment: true,
      httpMethod: true,
      operationPath: true,
      statusCode: true,
      version: true,
      origin: true,
      active: true,
      createdAt: true,
      expectedShape: true,
      sampleObservationId: true,
      apiSpecId: true,
      sourceSha256: true,
    },
  });
  const baselines = rows.slice(0, 100).flatMap((row) => {
    const shape = baselineShapeSchema.safeParse(row.expectedShape);
    if (!shape.success || !["OBSERVED", "CONTRACT"].includes(row.origin))
      return [];
    return [
      {
        id: row.id,
        provider: row.providerKey,
        environment: row.environment,
        method: row.httpMethod,
        path: row.operationPath,
        statusCode: row.statusCode,
        version: row.version,
        origin: row.origin,
        active: row.active,
        createdAt: row.createdAt.toISOString(),
        fields: shape.data.fields.map((field) => ({
          pointer: field.pointer,
          type: field.type,
          required: field.required,
        })),
        sampleObservationId: row.sampleObservationId,
        apiSpecId: row.apiSpecId,
        sourceSha256: row.sourceSha256,
      },
    ];
  });
  return {
    ...data,
    key,
    baselines,
    baselinesTruncated: rows.length > 100,
    invalidBaselines: rows.slice(0, 100).length - baselines.length,
  };
}
