import type { ValidationStatus } from "@/generated/prisma/client";
import type { ValidationEvidenceItem } from "@/lib/validation/validate-json-schema";

export const VALIDATION_EVIDENCE_VERSION = 1;

export type ValidationEvidenceV1 = {
  version: typeof VALIDATION_EVIDENCE_VERSION;
  checkedAt: string;
  scope: {
    label: string;
    openApiVersion: string | null;
    matchedPath: string | null;
    matchedMethod: string | null;
    covers: "json_request_body_only";
  };
  specRevision: {
    apiSpecId: string | null;
    sourceSha256: string | null;
  };
  validator: {
    engine: "ajv";
    schemaDialect: "https://json-schema.org/draft/2020-12/schema";
  };
  outcome: ValidationStatus;
  reasonCode: string | null;
  reasonMessage: string | null;
  plainEnglishSummary: string | null;
  findings: ValidationEvidenceItem[];
  redactedPaths: string[];
};

export function buildUnsupportedEvidenceV1(input: {
  reasonCode: string;
  reasonMessage: string;
  apiSpecId?: string | null;
  sourceSha256?: string | null;
  redactedPaths?: string[];
}): ValidationEvidenceV1 {
  return {
    version: VALIDATION_EVIDENCE_VERSION,
    checkedAt: new Date().toISOString(),
    scope: {
      label: "unsupported",
      openApiVersion: null,
      matchedPath: null,
      matchedMethod: null,
      covers: "json_request_body_only",
    },
    specRevision: {
      apiSpecId: input.apiSpecId ?? null,
      sourceSha256: input.sourceSha256 ?? null,
    },
    validator: {
      engine: "ajv",
      schemaDialect: "https://json-schema.org/draft/2020-12/schema",
    },
    outcome: "UNSUPPORTED",
    reasonCode: input.reasonCode,
    reasonMessage: input.reasonMessage,
    plainEnglishSummary: input.reasonMessage,
    findings: [],
    redactedPaths: input.redactedPaths ?? [],
  };
}
