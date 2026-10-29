import "server-only";
import { z } from "zod";
import {
  Prisma,
  type PrismaClient,
  type IntegrationObservation,
} from "@/generated/prisma/client";
import {
  baselineScope,
  canonical,
  digest,
  coverageSchema,
  observationSchema,
  outcomeSchema,
} from "@/lib/integration-observations/contract";
import {
  detectIntegrationChange,
  detectorEvidenceSchema,
} from "@/lib/integration-observations/detector";
export { observationFilters } from "@/lib/dashboard/observation-query";
export type { ObservationFilters } from "@/lib/dashboard/observation-query";
import {
  observationWhere,
  observationScope,
  type ObservationFilters,
} from "@/lib/dashboard/observation-query";
function summarize(
  row: IntegrationObservation,
  baseline: Parameters<typeof detectIntegrationChange>[1] = null,
  delayed = false,
) {
  const parsed = observationSchema.safeParse(row.envelope);
  const event =
    parsed.success &&
    parsed.data.integration.key === row.integrationKey &&
    parsed.data.integration.provider === row.providerKey &&
    parsed.data.integration.environment === row.environment &&
    parsed.data.operation.method === row.httpMethod &&
    parsed.data.operation.path === row.operationPath &&
    parsed.data.callId === row.callId &&
    parsed.data.attempt === row.attempt &&
    parsed.data.result.kind === row.resultKind &&
    (parsed.data.result.kind === "HTTP"
      ? parsed.data.result.statusCode
      : null) === row.statusCode &&
    parsed.data.sourceEventId === row.sourceEventId &&
    parsed.data.requestIncidentId === (row.requestIncidentId ?? undefined) &&
    digest(
      Object.fromEntries(
        Object.entries(parsed.data).filter(([key]) => key !== "sourceEventId"),
      ),
    ) === row.payloadDigest &&
    parsed.data.occurredAt === row.occurredAt.toISOString() &&
    parsed.data.correlation?.id === (row.correlationId ?? undefined) &&
    parsed.data.correlation?.kind === (row.correlationKind ?? undefined) &&
    parsed.data.correlation?.attempt ===
      (row.correlationAttempt ?? undefined) &&
    baselineScope(
      parsed.data,
      parsed.data.result.kind === "HTTP" ? parsed.data.result.statusCode : 0,
      parsed.data.capture.pointers,
    ) === row.scopeKey
      ? parsed.data
      : null;
  const candidate = detectorEvidenceSchema.safeParse(row.detectorEvidence);
  const evidence =
    candidate.success &&
    event &&
    canonical(detectIntegrationChange(event, baseline)) ===
      canonical(candidate.data)
      ? candidate
      : null;
  return {
    id: row.id,
    integration: event?.integration ?? null,
    operation: event?.operation ?? null,
    result: event?.result ?? null,
    durationMs: event?.durationMs ?? null,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    state:
      row.processingState === "PENDING"
        ? delayed
          ? "PROCESSING_DELAYED"
          : "Pending"
        : event && evidence
          ? evidence.data.code
          : "Incomplete",
    event,
  };
}
export async function listObservations(
  db: PrismaClient,
  workspaceId: string,
  filters: ObservationFilters,
) {
  const where = observationWhere(workspaceId, filters);
  const scope = observationScope(workspaceId, filters);
  const [
    rows,
    total,
    unmatched,
    coverageRows,
    truncatedOutcomes,
    scopeTotal,
    workspaceTotal,
    configuredCount,
  ] = await Promise.all([
    db.integrationObservation.findMany({
      where,
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: 20,
      skip: (filters.page - 1) * 20,
      include: {
        outboxEvents: {
          take: 1,
          orderBy: { createdAt: "desc" },
          select: { dispatchStatus: true, lastError: true },
        },
        baseline: {
          select: {
            id: true,
            version: true,
            origin: true,
            expectedShape: true,
            scopeKey: true,
          },
        },
      },
    }),
    db.integrationObservation.count({ where }),
    db.integrationWorkflowOutcome.count({
      where: { ...scope, observationLinks: { none: {} } },
    }),
    db.$queryRaw<
      {
        envelope: unknown;
        instance_id: string;
        sequence: number;
        integration_key: string;
        provider_key: string;
        environment: string;
        payload_digest: string;
      }[]
    >(
      Prisma.sql`SELECT * FROM (SELECT DISTINCT ON (instance_id) envelope, instance_id, sequence,integration_key,provider_key,environment,payload_digest FROM integration_capture_coverage WHERE workspace_id=${workspaceId}::uuid ${filters.env ? Prisma.sql`AND environment=${filters.env}` : Prisma.empty} ${filters.svc ? Prisma.sql`AND integration_key=${filters.svc}` : Prisma.empty} ${filters.provider ? Prisma.sql`AND provider_key=${filters.provider}` : Prisma.empty} ORDER BY instance_id,sequence DESC) latest ORDER BY instance_id LIMIT 101`,
    ),
    db.integrationWorkflowOutcome.count({
      where: { ...scope, linkTruncated: true },
    }),
    db.integrationObservation.count({ where: scope }),
    db.integrationObservation.count({ where: { workspaceId } }),
    db.integrationResponseBaseline.count({ where: scope }),
  ]);
  const coverage = coverageRows.slice(0, 100).flatMap((row) => {
    const p = coverageSchema.safeParse(row.envelope);
    return p.success &&
      p.data.instanceId === row.instance_id &&
      p.data.sequence === row.sequence &&
      p.data.integration.key === row.integration_key &&
      p.data.integration.provider === row.provider_key &&
      p.data.integration.environment === row.environment &&
      digest(
        Object.fromEntries(
          Object.entries(p.data).filter(([key]) => key !== "sourceEventId"),
        ),
      ) === row.payload_digest
      ? [p.data]
      : [];
  });
  return {
    rows: rows.map(({ ...row }) => {
      const { event, ...summary } = summarize(
        row,
        row.baseline?.scopeKey === row.scopeKey ? row.baseline : null,
        row.outboxEvents.some(
          (event) =>
            event.dispatchStatus === "FAILED" || event.lastError !== null,
        ),
      );
      void event;
      return summary;
    }),
    total,
    scopeTotal,
    workspaceTotal,
    configuredCount,
    pages: Math.max(1, Math.ceil(total / 20)),
    unmatched,
    truncatedOutcomes,
    coverage,
    coverageTruncated: coverageRows.length > 100,
    coverageInvalid: coverageRows.slice(0, 100).length - coverage.length,
  };
}
export async function loadObservation(
  db: PrismaClient,
  workspaceId: string,
  id: string,
) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const row = await db.integrationObservation.findFirst({
    where: { workspaceId, id },
    include: {
      outboxEvents: {
        take: 1,
        orderBy: { createdAt: "desc" },
        select: { dispatchStatus: true, lastError: true },
      },
    },
  });
  if (!row) return null;
  const delayed = row.outboxEvents.some(
    (event) => event.dispatchStatus === "FAILED" || event.lastError !== null,
  );
  const summary = summarize(row, null, delayed),
    event = summary.event;
  const baseline = row.baselineId
    ? await db.integrationResponseBaseline.findFirst({
        where: { workspaceId, id: row.baselineId, scopeKey: row.scopeKey },
        select: {
          id: true,
          origin: true,
          version: true,
          expectedShape: true,
          apiSpecId: true,
          sourceSha256: true,
          sampleObservationId: true,
          createdAt: true,
        },
      })
    : null;
  const recomputed = event ? detectIntegrationChange(event, baseline) : null,
    stored = detectorEvidenceSchema.safeParse(row.detectorEvidence);
  const evidence =
    row.processingState === "DONE" &&
    recomputed &&
    stored.success &&
    canonical(recomputed) === canonical(stored.data)
      ? stored.data
      : null;
  const links = await db.integrationOutcomeLink.findMany({
    where: { workspaceId, observationId: id },
    take: 101,
    orderBy: { createdAt: "asc" },
    include: { outcome: true },
  });
  const outcomes = links.slice(0, 100).flatMap((link) => {
    const parsed = outcomeSchema.safeParse(link.outcome.envelope);
    if (
      !event?.correlation ||
      !parsed.success ||
      canonical(parsed.data.integration) !== canonical(event.integration) ||
      canonical(parsed.data.correlation) !== canonical(event.correlation) ||
      parsed.data.outcome !== link.outcome.outcome
    )
      return [];
    return [
      {
        id: link.outcome.id,
        outcome: parsed.data.outcome,
        correlation: parsed.data.correlation,
        occurredAt: parsed.data.occurredAt,
        receivedAt: link.outcome.receivedAt.toISOString(),
      },
    ];
  });
  const relatedWhere = {
    workspaceId,
    baselineId: row.baselineId,
    driftSignature: row.driftSignature,
  };
  const [related, totalRelated, request] = await Promise.all([
    row.driftSignature
      ? db.integrationObservation.findMany({
          where: relatedWhere,
          take: 20,
          orderBy: { receivedAt: "desc" },
          select: { id: true, receivedAt: true },
        })
      : [],
    row.driftSignature
      ? db.integrationObservation.count({ where: relatedWhere })
      : 0,
    event?.requestIncidentId
      ? db.incident.findFirst({
          where: {
            id: event.requestIncidentId,
            workspaceId,
            apiKey: event.integration.key,
            environment: event.integration.environment,
            httpMethod: event.operation.method,
            requestPath: event.operation.path,
          },
          select: { id: true, validationStatus: true, apiSpecId: true },
        })
      : null,
  ]);
  return {
    ...summary,
    state:
      row.processingState === "PENDING"
        ? delayed ? "PROCESSING_DELAYED" : "Pending"
        : (evidence?.code ?? "Incomplete"),
    evidence,
    baseline: baseline
      ? {
          id: baseline.id,
          origin: baseline.origin,
          version: baseline.version,
          apiSpecId: baseline.apiSpecId,
          sourceSha256: baseline.sourceSha256,
          sampleObservationId: baseline.sampleObservationId,
          createdAt: baseline.createdAt.toISOString(),
        }
      : null,
    outcomes,
    linksTruncated:
      row.linkTruncated ||
      links.length > 100 ||
      links.some((link) => link.outcome.linkTruncated),
    invalidLinks: links.slice(0, 100).length - outcomes.length,
    related,
    totalRelated,
    request,
  };
}
