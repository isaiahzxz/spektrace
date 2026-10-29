import { createHash } from "node:crypto";
import { ActorType, AuditEventType, type Prisma, type PrismaClient } from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import type { PrismaTransaction } from "@/lib/db";
import { inspectCandidate } from "@/lib/dashboard/candidate-json";
import { parseValidationEvidence } from "@/lib/dashboard/evidence-adapter";
import { resolveOpenApiJsonRequestBodySchema } from "@/lib/validation/resolve-openapi-request-schema";
import { validateJsonSchemaPayload } from "@/lib/validation/validate-json-schema";

type Db = PrismaClient | PrismaTransaction;

export const LOCAL_PILOT_ACTOR = "local-pilot";

/**
 * Acceptance rechecks the submitted candidate inside a row lock.
 * "Active" means the specification that is active at acceptance time.
 * A previously displayed Run Test result is not an authorization.
 * Acceptance records a human decision. It does not change the original
 * request, the original validation evidence, or send a customer message.
 */
export type CandidateCheck = {
  ok: boolean;
  label: string;
  detail: string;
  eligible: boolean;
  candidateSha256: string | null;
  specId: string | null;
  specLabel: string | null;
};

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export async function evaluateCandidate(
  db: Db,
  workspaceId: string,
  input: { incidentId: string; candidateText: string; revision: "pinned" | "active" },
): Promise<CandidateCheck> {
  const inspected = inspectCandidate(input.candidateText);
  const candidateSha256 = digest(input.candidateText);
  if (!inspected.ok) {
    return { ok: false, label: "Malformed JSON", detail: inspected.reason, eligible: false, candidateSha256, specId: null, specLabel: null };
  }

  const incident = await db.incident.findFirst({
    where: { id: input.incidentId, workspaceId },
    select: {
      id: true,
      apiKey: true,
      environment: true,
      httpMethod: true,
      requestPath: true,
      apiSpecId: true,
      validationEvidence: true,
    },
  });
  if (!incident) {
    return { ok: false, label: "Not found", detail: "That incident is not in this workspace.", eligible: false, candidateSha256, specId: null, specLabel: null };
  }

  const parsed = parseValidationEvidence(incident.validationEvidence);
  if (parsed.format === "v1" && parsed.redactedPaths.length > 0) {
    return {
      ok: false,
      label: "Indeterminate",
      detail: "Credential-like fields were redacted, so this candidate cannot be checked conclusively.",
      eligible: false,
      candidateSha256,
      specId: null,
      specLabel: null,
    };
  }

  const spec =
    input.revision === "pinned"
      ? incident.apiSpecId
        ? await db.apiSpec.findFirst({ where: { id: incident.apiSpecId, workspaceId, apiKey: incident.apiKey, environment: incident.environment } })
        : null
      : await db.apiSpec.findFirst({
          where: { workspaceId, apiKey: incident.apiKey, environment: incident.environment, isActive: true },
          orderBy: { createdAt: "desc" },
        });

  if (!spec) {
    return { ok: false, label: "No specification", detail: "The selected revision is not available in this workspace.", eligible: false, candidateSha256, specId: null, specLabel: null };
  }

  const specLabel = `${spec.name} ${spec.version}`;
  const resolved = resolveOpenApiJsonRequestBodySchema({
    parsedDocument: spec.parsedDocument,
    openApiVersion: spec.openApiVersion,
    apiSpecId: spec.id,
    sourceSha256: spec.sourceSha256,
    httpMethod: incident.httpMethod,
    requestPath: incident.requestPath,
  });
  if (resolved.status !== "resolved") {
    return { ok: false, label: "Unsupported", detail: resolved.reasonMessage, eligible: false, candidateSha256, specId: spec.id, specLabel };
  }

  const checked = validateJsonSchemaPayload(resolved.requestBodySchema, inspected.value);
  if (checked.status === "passed") {
    return {
      ok: true,
      label: "Synthetic test passed",
      detail: `Checked against ${specLabel}. This did not change the stored incident.`,
      eligible: true,
      candidateSha256,
      specId: spec.id,
      specLabel,
    };
  }
  if (checked.status === "mismatch") {
    const first = checked.evidence[0];
    return {
      ok: false,
      label: "Schema violation",
      detail: first ? `${first.jsonPointer}: ${first.message}` : "The candidate does not match the specification.",
      eligible: false,
      candidateSha256,
      specId: spec.id,
      specLabel,
    };
  }
  if (checked.status === "unsupported") {
    return { ok: false, label: "Unsupported", detail: checked.reason, eligible: false, candidateSha256, specId: spec.id, specLabel };
  }
  return { ok: false, label: "Technical failure", detail: checked.reason, eligible: false, candidateSha256, specId: spec.id, specLabel };
}

type ApprovalMetadata = { candidateSha256?: unknown; specId?: unknown };

function readApproval(metadata: Prisma.JsonValue | null) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const row = metadata as ApprovalMetadata;
  return {
    candidateSha256: typeof row.candidateSha256 === "string" ? row.candidateSha256 : "",
    specId: typeof row.specId === "string" ? row.specId : "",
  };
}

export async function applyAcceptance(
  tx: PrismaTransaction,
  workspaceId: string,
  input: { incidentId: string; candidateText: string; revision: "pinned" | "active" },
): Promise<{ ok: boolean; detail: string }> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM incidents WHERE id = ${input.incidentId}::uuid AND workspace_id = ${workspaceId}::uuid FOR UPDATE
  `;
  if (locked.length === 0) {
    return { ok: false, detail: "That incident is not in this workspace." };
  }

  const checked = await evaluateCandidate(tx, workspaceId, input);
  if (!checked.eligible || !checked.candidateSha256 || !checked.specId) {
    return { ok: false, detail: checked.detail };
  }

  const prior = await tx.auditLog.findFirst({
    where: { workspaceId, incidentId: input.incidentId, eventType: "INCIDENT_APPROVED" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { metadata: true },
  });
  const previous = readApproval(prior?.metadata ?? null);
  if (previous?.candidateSha256) {
    if (previous.candidateSha256 === checked.candidateSha256 && previous.specId === checked.specId) {
      return { ok: true, detail: "This tested correction was already accepted." };
    }
    return { ok: false, detail: "A different correction was already accepted for this incident." };
  }

  const updated = await tx.incident.updateMany({
    where: { id: input.incidentId, workspaceId, status: { not: "APPROVED" } },
    data: {
      status: "APPROVED",
      approvedBy: LOCAL_PILOT_ACTOR,
      approvedAt: new Date(),
    },
  });
  if (updated.count !== 1) {
    const again = await tx.auditLog.findFirst({
      where: { workspaceId, incidentId: input.incidentId, eventType: "INCIDENT_APPROVED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { metadata: true },
    });
    const raced = readApproval(again?.metadata ?? null);
    if (raced?.candidateSha256 === checked.candidateSha256 && raced.specId === checked.specId) {
      return { ok: true, detail: "This tested correction was already accepted." };
    }
    return { ok: false, detail: "The acceptance did not apply. The stored incident was left unchanged." };
  }

  await appendAuditLog(tx, {
    workspaceId,
    incidentId: input.incidentId,
    eventType: AuditEventType.INCIDENT_APPROVED,
    actorType: ActorType.HUMAN,
    actorId: LOCAL_PILOT_ACTOR,
    metadata: {
      kind: "tested-correction",
      candidateSha256: checked.candidateSha256,
      specId: checked.specId,
      specLabel: checked.specLabel,
      limit: "Local pilot operator on this machine. Not an authenticated user. Does not send a customer message or approve a future draft.",
    },
  });

  return {
    ok: true,
    detail: "Accepted the tested correction. The original findings stay as recorded. Nothing was sent to a customer.",
  };
}

export async function acceptTestedCorrection(
  db: PrismaClient,
  workspaceId: string,
  input: { incidentId: string; candidateText: string; revision: "pinned" | "active" },
) {
  return db.$transaction((tx) => applyAcceptance(tx, workspaceId, input));
}
