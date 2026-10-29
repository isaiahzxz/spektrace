import { IncidentSource } from "@/generated/prisma/client";
import { APPLICATION_MONITORING_ADAPTER } from "@/lib/ingestion/application-monitoring/config";
import type {
  ApplicationHttpFailureEvent,
  ApplicationMonitoringScope,
} from "@/lib/ingestion/application-monitoring/types";
import { redactSanitizedRequestBody } from "@/lib/redaction/sanitize-body";
import {
  assertBodySizeLimit,
  incidentSubmissionSchema,
  type IncidentSubmissionInput,
} from "@/lib/validation/incident-envelope";

export type BuildEnvelopeResult =
  | { ok: true; envelope: IncidentSubmissionInput }
  | { ok: false; code: string; message: string };

export function buildApplicationMonitoringEnvelope(
  failure: ApplicationHttpFailureEvent,
  scope: ApplicationMonitoringScope,
): BuildEnvelopeResult {
  if (!Number.isInteger(failure.statusCode) || failure.statusCode < 400 || failure.statusCode > 499) {
    return {
      ok: false,
      code: "APPMON_STATUS_OUT_OF_RANGE",
      message: "Application monitoring only forwards HTTP 4xx failures.",
    };
  }

  let sanitizedBody: unknown | null | undefined = failure.sanitizedRequestBody;
  if (sanitizedBody !== undefined && sanitizedBody !== null) {
    const redaction = redactSanitizedRequestBody(sanitizedBody);
    if (redaction.validationBlocked || redaction.incomplete) {
      return {
        ok: false,
        code: "APPMON_BODY_REDACTION_BLOCKED",
        message: "Request body could not be sanitized safely for ingestion.",
      };
    }
    sanitizedBody = redaction.value;
  }

  try {
    assertBodySizeLimit(sanitizedBody);
  } catch {
    return {
      ok: false,
      code: "APPMON_BODY_TOO_LARGE",
      message: "Sanitized request body exceeds ingestion size limits.",
    };
  }

  const client = {
    sdkName: APPLICATION_MONITORING_ADAPTER.sdkName,
    sdkVersion: APPLICATION_MONITORING_ADAPTER.sdkVersion,
    ...failure.client,
  };

  const candidate = {
    source: IncidentSource.WEBHOOK,
    sourceEventId: failure.sourceEventId,
    apiKey: scope.apiKey,
    environment: scope.environment,
    httpMethod: failure.httpMethod,
    requestPath: failure.requestPath,
    statusCode: failure.statusCode,
    occurredAt: failure.occurredAt,
    clientReference: failure.clientReference,
    client,
    ...(sanitizedBody !== undefined ? { sanitizedRequestBody: sanitizedBody } : {}),
  };

  const parsed = incidentSubmissionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: "APPMON_ENVELOPE_INVALID",
      message: "Failure event does not match the incident ingestion contract.",
    };
  }

  return { ok: true, envelope: parsed.data };
}
