import type { Incident } from "@/generated/prisma/client";
import type { ValidationEvidenceV1 } from "@/lib/validation/validation-evidence-v1";

export type IncidentResponseBody = {
  id: string;
  workspaceId: string;
  apiKey: string;
  environment: string;
  applicationName: string | null;
  applicationVersion: string | null;
  platform: string | null;
  sdkName: string | null;
  sdkVersion: string | null;
  apiSpecId: string | null;
  revisionSelectionMode: string;
  revisionSelection: unknown;
  senderId: string | null;
  senderBindingId: string | null;
  senderProvenance: unknown;
  reportedClientRef: string | null;
  source: string;
  sourceEventId: string;
  httpMethod: string;
  requestPath: string;
  statusCode: number;
  clientReference: string | null;
  sanitizedRequestBody: unknown;
  status: string;
  validationStatus: string;
  validationEvidence: ValidationEvidenceV1 | null;
  draftText: string | null;
  draftCitations: unknown;
  draftVersion: number;
  approvedBy: string | null;
  approvedAt: string | null;
  occurredAt: string;
  receivedAt: string;
  validatedAt: string | null;
  processingErrorCode: string | null;
  processingErrorMessage: string | null;
};

export function serializeIncident(incident: Incident): IncidentResponseBody {
  return {
    id: incident.id,
    workspaceId: incident.workspaceId,
    apiKey: incident.apiKey,
    environment: incident.environment,
    applicationName: incident.applicationName,
    applicationVersion: incident.applicationVersion,
    platform: incident.platform,
    sdkName: incident.sdkName,
    sdkVersion: incident.sdkVersion,
    apiSpecId: incident.apiSpecId,
    revisionSelectionMode: incident.revisionSelectionMode ?? "legacy_not_recorded",
    revisionSelection: incident.revisionSelection ?? { reason: "LEGACY_SELECTION_NOT_RECORDED", runtimeVerified: false },
    senderId: incident.senderId,
    senderBindingId: incident.senderBindingId,
    reportedClientRef: incident.reportedClientRef,
    senderProvenance: incident.senderProvenance ?? { assurance: "legacy_not_recorded", originalAuthenticationVerifiedBySpekTrace: false },
    source: incident.source,
    sourceEventId: incident.sourceEventId,
    httpMethod: incident.httpMethod,
    requestPath: incident.requestPath,
    statusCode: incident.statusCode,
    clientReference: incident.clientReference,
    sanitizedRequestBody: incident.sanitizedRequestBody,
    status: incident.status,
    validationStatus: incident.validationStatus,
    validationEvidence: (incident.validationEvidence as ValidationEvidenceV1 | null) ?? null,
    draftText: incident.draftText,
    draftCitations: incident.draftCitations,
    draftVersion: incident.draftVersion,
    approvedBy: incident.approvedBy,
    approvedAt: incident.approvedAt?.toISOString() ?? null,
    occurredAt: incident.occurredAt.toISOString(),
    receivedAt: incident.receivedAt.toISOString(),
    validatedAt: incident.validatedAt?.toISOString() ?? null,
    processingErrorCode: incident.processingErrorCode,
    processingErrorMessage: incident.processingErrorMessage,
  };
}
