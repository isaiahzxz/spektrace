import { createHash } from "node:crypto";
import { ActorType, AuditEventType, type Prisma, type PrismaClient } from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import {
  HISTORICAL_REVISION_CANDIDATE_LIMIT, REVISION_SELECTION_VERSION,
  historicalBindingAllowlistSchema, historicalBindingImportSchema, historicalSelectionReason,
  type HistoricalBindingImport,
} from "@/lib/specs/historical-revisions";

export class HistoricalBindingError extends Error {
  constructor(public readonly code: "NOT_ALLOWLISTED" | "INVALID_BINDING" | "IMPORT_CONFLICT") {
    super(code); this.name = "HistoricalBindingError";
  }
}

// Imports and selections in this scope have one ordering, including empty scopes.
export async function lockHistoricalScope(tx: Prisma.TransactionClient, workspaceId: string, apiKey: string, environment: string) {
  const key = JSON.stringify(["historical-revision", workspaceId, apiKey, environment]);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}

export async function importHistoricalBinding(db: PrismaClient, workspaceId: string, raw: HistoricalBindingImport) {
  const input = historicalBindingImportSchema.parse(raw);
  let entries: ReturnType<typeof historicalBindingAllowlistSchema.parse>;
  try { entries = historicalBindingAllowlistSchema.parse(JSON.parse(process.env.SPEKTRACE_HISTORICAL_BINDING_ALLOWLIST ?? "[]")); }
  catch { throw new HistoricalBindingError("NOT_ALLOWLISTED"); }
  if (!entries.some((entry) => entry.integrationKey === input.integrationKey && entry.apiKey === input.apiKey && entry.environment === input.environment))
    throw new HistoricalBindingError("NOT_ALLOWLISTED");
  const importDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return db.$transaction(async (tx) => {
    await lockHistoricalScope(tx, workspaceId, input.apiKey, input.environment);
    const existing = await tx.contractRevisionInterval.findUnique({ where: {
      workspaceId_integrationKey_sourceIntervalId: { workspaceId, integrationKey: input.integrationKey, sourceIntervalId: input.sourceIntervalId },
    } });
    if (existing) {
      if (existing.importDigest !== importDigest) throw new HistoricalBindingError("IMPORT_CONFLICT");
      return { binding: existing, created: false };
    }
    const spec = await tx.apiSpec.findFirst({ where: { id: input.apiSpecId, workspaceId, apiKey: input.apiKey,
      environment: input.environment, sourceSha256: input.sourceSha256 } });
    const deployment = await tx.deploymentRecord.findFirst({ where: { workspaceId, integrationKey: input.integrationKey,
      sourceDeploymentId: input.sourceDeploymentId, apiKey: input.apiKey, environment: input.environment, apiSpecId: input.apiSpecId } });
    if (!spec || !deployment) throw new HistoricalBindingError("INVALID_BINDING");
    const binding = await tx.contractRevisionInterval.create({ data: {
      ...input, workspaceId, deploymentRecordId: deployment.id, importDigest,
      validFrom: new Date(input.validFrom), validUntil: new Date(input.validUntil),
      importedBy: "pilot_internal_admin", assertionKind: "operator_asserted_interval",
    } });
    await appendAuditLog(tx, { workspaceId, eventType: AuditEventType.HISTORICAL_BINDING_IMPORTED, actorType: ActorType.SYSTEM,
      metadata: { bindingId: binding.id, apiSpecId: spec.id, integrationKey: input.integrationKey } });
    return { binding, created: true };
  });
}

export async function selectHistoricalRevision(tx: Prisma.TransactionClient, workspaceId: string, apiKey: string,
  environment: string, occurredAt: string) {
  await lockHistoricalScope(tx, workspaceId, apiKey, environment);
  const selectedAt = new Date();
  const validTime = historicalSelectionReason(occurredAt, selectedAt, 0) !== "HISTORICAL_OCCURRENCE_INVALID";
  const candidates = validTime ? await tx.contractRevisionInterval.findMany({ where: {
    workspaceId, apiKey, environment, validFrom: { lte: new Date(occurredAt) }, validUntil: { gt: new Date(occurredAt) },
  }, orderBy: { id: "asc" }, take: HISTORICAL_REVISION_CANDIDATE_LIMIT + 1 }) : [];
  let reason = historicalSelectionReason(occurredAt, selectedAt, candidates.length);
  const candidate = reason === "HISTORICAL_BINDING_SELECTED" ? candidates[0] : undefined;
  const spec = candidate ? await tx.apiSpec.findFirst({ where: { id: candidate.apiSpecId, workspaceId, apiKey, environment,
    sourceSha256: candidate.sourceSha256 } }) : null;
  const deployment = candidate ? await tx.deploymentRecord.findFirst({ where: { id: candidate.deploymentRecordId, workspaceId,
    integrationKey: candidate.integrationKey, sourceDeploymentId: candidate.sourceDeploymentId, apiKey, environment, apiSpecId: candidate.apiSpecId } }) : null;
  if (candidate && (!spec || !deployment)) reason = "HISTORICAL_BINDING_INVALID";
  const selected = reason === "HISTORICAL_BINDING_SELECTED" && spec ? spec : null;
  const provenance: Prisma.InputJsonObject = {
    version: REVISION_SELECTION_VERSION, mode: "historical", reason, selectedAt: selectedAt.toISOString(),
    timeBasis: "reported_occurred_at", reportedOccurredAt: occurredAt,
    runtimeVerified: false, authority: "operator_asserted_interval",
    candidateIds: candidates.map((row) => row.id), candidatesTruncated: candidates.length > HISTORICAL_REVISION_CANDIDATE_LIMIT,
    ...(selected && candidate ? { apiSpecId: selected.id, sourceSha256: selected.sourceSha256, bindingId: candidate.id,
      integrationKey: candidate.integrationKey, sourceIntervalId: candidate.sourceIntervalId, deploymentRecordId: candidate.deploymentRecordId,
      sourceDeploymentId: candidate.sourceDeploymentId, importedAt: candidate.createdAt.toISOString(), importedBy: candidate.importedBy,
      importDigest: candidate.importDigest, validFrom: candidate.validFrom.toISOString(), validUntil: candidate.validUntil.toISOString() } : {}),
  };
  return { spec: selected, reason, provenance };
}
