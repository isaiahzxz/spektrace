import {
  ActorType,
  AuditEventType,
  IncidentStatus,
  Prisma,
  ValidationStatus,
  type PrismaClient,
} from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import { SUPPORTED_JSON_SCHEMA_DIALECT } from "@/lib/validation/ajv";
import { plainEnglishFromFindings } from "@/lib/validation/explain-mismatch";
import { resolveOpenApiJsonRequestBodySchema } from "@/lib/validation/resolve-openapi-request-schema";
import {
  VALIDATION_EVIDENCE_VERSION,
  buildUnsupportedEvidenceV1,
  type ValidationEvidenceV1,
} from "@/lib/validation/validation-evidence-v1";
import { scheduleInvestigationGroupingOutbox } from "@/lib/investigation/schedule-outbox";
import { validateJsonSchemaPayload } from "@/lib/validation/validate-json-schema";

const STALE_VALIDATING_MS = 2 * 60 * 1000;

export type ProcessIncidentResult =
  | { status: "skipped"; reason: string }
  | { status: "processed"; validationStatus: ValidationStatus };

export async function processIncidentValidation(
  prisma: PrismaClient,
  workspaceId: string,
  incidentId: string,
): Promise<ProcessIncidentResult> {
  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, workspaceId },
    include: { apiSpec: true },
  });

  if (!incident) {
    return { status: "skipped", reason: "incident_not_found" };
  }

  if (
    incident.status === IncidentStatus.NEEDS_REVIEW &&
    incident.validationStatus !== ValidationStatus.NOT_RUN
  ) {
    return { status: "skipped", reason: "already_completed" };
  }

  if (incident.status === IncidentStatus.VALIDATING) {
    const stale =
      Date.now() - incident.updatedAt.getTime() > STALE_VALIDATING_MS;
    if (!stale) {
      return { status: "skipped", reason: "in_progress" };
    }
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.incident.findFirst({
      where: { id: incidentId, workspaceId },
      include: { apiSpec: true },
    });
    if (!current) {
      return { status: "skipped", reason: "incident_not_found" };
    }

    if (
      current.status === IncidentStatus.NEEDS_REVIEW &&
      current.validationStatus !== ValidationStatus.NOT_RUN
    ) {
      return { status: "skipped", reason: "already_completed" };
    }

    await tx.incident.update({
      where: { id: current.id },
      data: { status: IncidentStatus.VALIDATING },
    });

    await appendAuditLog(tx, {
      workspaceId,
      incidentId: current.id,
      eventType: AuditEventType.VALIDATION_STARTED,
      actorType: ActorType.SYSTEM,
      metadata: { apiSpecId: current.apiSpecId },
    });

    let validationStatus: ValidationStatus = ValidationStatus.ERROR;
    let evidence: ValidationEvidenceV1;
    let processingErrorCode: string | null = null;
    let processingErrorMessage: string | null = null;

    try {
      if (current.validationStatus === ValidationStatus.UNSUPPORTED && current.validationEvidence) {
        validationStatus = ValidationStatus.UNSUPPORTED;
        evidence = current.validationEvidence as ValidationEvidenceV1;
      } else if (!current.apiSpec || !current.apiSpecId) {
        validationStatus = ValidationStatus.UNSUPPORTED;
        evidence = buildUnsupportedEvidenceV1({
          reasonCode: "ACTIVE_SPEC_NOT_FOUND",
          reasonMessage: `No API specification revision is pinned for apiKey "${current.apiKey}".`,
        });
      } else {
        const resolved = resolveOpenApiJsonRequestBodySchema({
          parsedDocument: current.apiSpec.parsedDocument,
          openApiVersion: current.apiSpec.openApiVersion,
          apiSpecId: current.apiSpec.id,
          sourceSha256: current.apiSpec.sourceSha256,
          httpMethod: current.httpMethod,
          requestPath: current.requestPath,
        });

        if (resolved.status === "unsupported") {
          validationStatus = ValidationStatus.UNSUPPORTED;
          evidence = buildUnsupportedEvidenceV1({
            reasonCode: resolved.reasonCode,
            reasonMessage: resolved.reasonMessage,
            apiSpecId: current.apiSpec.id,
            sourceSha256: current.apiSpec.sourceSha256,
          });
        } else {
          const payload = current.sanitizedRequestBody;
          if (payload === null || payload === undefined) {
            validationStatus = ValidationStatus.UNSUPPORTED;
            evidence = buildUnsupportedEvidenceV1({
              reasonCode: "REQUEST_BODY_MISSING",
              reasonMessage: "A JSON request body is required for this validation scope.",
              apiSpecId: current.apiSpec.id,
              sourceSha256: current.apiSpec.sourceSha256,
            });
          } else {
            const result = validateJsonSchemaPayload(
              resolved.requestBodySchema,
              payload,
            );

            if (result.status === "passed") {
              validationStatus = ValidationStatus.PASSED;
              evidence = {
                version: VALIDATION_EVIDENCE_VERSION,
                checkedAt: new Date().toISOString(),
                scope: {
                  label: "openapi_request_body",
                  openApiVersion: resolved.openApiVersion,
                  matchedPath: resolved.matchedPath,
                  matchedMethod: resolved.matchedMethod,
                  covers: "json_request_body_only",
                },
                specRevision: {
                  apiSpecId: resolved.apiSpecId,
                  sourceSha256: resolved.sourceSha256,
                },
                validator: {
                  engine: "ajv",
                  schemaDialect: SUPPORTED_JSON_SCHEMA_DIALECT,
                },
                outcome: ValidationStatus.PASSED,
                reasonCode: null,
                reasonMessage:
                  "The supported JSON request body schema matched. This does not explain the original HTTP 4xx response.",
                plainEnglishSummary:
                  "The supported JSON request body schema matched. This does not explain the original HTTP 4xx response.",
                findings: [],
                redactedPaths: [],
              };
            } else if (result.status === "mismatch") {
              validationStatus = ValidationStatus.MISMATCH;
              const summary = plainEnglishFromFindings(result.evidence);
              evidence = {
                version: VALIDATION_EVIDENCE_VERSION,
                checkedAt: new Date().toISOString(),
                scope: {
                  label: "openapi_request_body",
                  openApiVersion: resolved.openApiVersion,
                  matchedPath: resolved.matchedPath,
                  matchedMethod: resolved.matchedMethod,
                  covers: "json_request_body_only",
                },
                specRevision: {
                  apiSpecId: resolved.apiSpecId,
                  sourceSha256: resolved.sourceSha256,
                },
                validator: {
                  engine: "ajv",
                  schemaDialect: SUPPORTED_JSON_SCHEMA_DIALECT,
                },
                outcome: ValidationStatus.MISMATCH,
                reasonCode: "SCHEMA_MISMATCH",
                reasonMessage: summary ?? "The request body did not match the supported schema.",
                plainEnglishSummary: summary,
                findings: result.evidence,
                redactedPaths: [],
              };
            } else if (result.status === "unsupported") {
              validationStatus = ValidationStatus.UNSUPPORTED;
              evidence = buildUnsupportedEvidenceV1({
                reasonCode: "SCHEMA_UNSUPPORTED",
                reasonMessage: result.reason,
                apiSpecId: current.apiSpec.id,
                sourceSha256: current.apiSpec.sourceSha256,
              });
            } else {
              validationStatus = ValidationStatus.ERROR;
              processingErrorCode = "VALIDATION_ERROR";
              processingErrorMessage = result.reason;
              evidence = buildUnsupportedEvidenceV1({
                reasonCode: "VALIDATION_ERROR",
                reasonMessage: result.reason,
                apiSpecId: current.apiSpec.id,
                sourceSha256: current.apiSpec.sourceSha256,
              });
            }
          }
        }
      }
    } catch (error) {
      validationStatus = ValidationStatus.ERROR;
      processingErrorCode = "VALIDATION_EXCEPTION";
      processingErrorMessage =
        error instanceof Error ? error.message : "Unknown validation failure";
      evidence = buildUnsupportedEvidenceV1({
        reasonCode: processingErrorCode,
        reasonMessage: processingErrorMessage,
      });
    }

    await tx.incident.update({
      where: { id: current.id },
      data: {
        status: IncidentStatus.NEEDS_REVIEW,
        validationStatus,
        validationEvidence: evidence as Prisma.InputJsonValue,
        validatedAt: new Date(),
        processingErrorCode,
        processingErrorMessage,
      },
    });

    await appendAuditLog(tx, {
      workspaceId,
      incidentId: current.id,
      eventType:
        validationStatus === ValidationStatus.ERROR
          ? AuditEventType.VALIDATION_FAILED
          : AuditEventType.VALIDATION_COMPLETED,
      actorType: ActorType.SYSTEM,
      metadata: {
        validationStatus,
        reasonCode: evidence.reasonCode,
      },
    });

    await scheduleInvestigationGroupingOutbox(tx, workspaceId, current.id);

    return { status: "processed", validationStatus };
  });
}
