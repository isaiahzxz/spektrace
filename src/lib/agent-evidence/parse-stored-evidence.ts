import { ValidationStatus } from "@/generated/prisma/client";
import { z } from "zod";
import type { ValidationEvidenceItem } from "@/lib/validation/validate-json-schema";
import { VALIDATION_EVIDENCE_VERSION } from "@/lib/validation/validation-evidence-v1";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const findingSchema = z.object({
  jsonPointer: z.string(),
  keyword: z.string(),
  schemaPath: z.string().catch(""),
  message: z.string().catch(""),
  expected: z.string().optional().catch(undefined),
  observedType: z.string().optional().catch(undefined),
  missingProperty: z.string().optional().catch(undefined),
  additionalProperty: z.string().optional().catch(undefined),
  allowedValues: z.array(scalar).optional().catch(undefined),
});

const v1Schema = z.object({
  version: z.literal(VALIDATION_EVIDENCE_VERSION),
  checkedAt: z.string().optional().catch(undefined),
  outcome: z.string().optional().catch(undefined),
  reasonCode: z.string().nullable().optional().catch(null),
  scope: z
    .object({
      covers: z.string().nullable().optional().catch(null),
      matchedPath: z.string().nullable().optional().catch(null),
      matchedMethod: z.string().nullable().optional().catch(null),
    })
    .optional()
    .catch(undefined),
  specRevision: z
    .object({
      apiSpecId: z.string().nullable().optional().catch(null),
      sourceSha256: z.string().nullable().optional().catch(null),
    })
    .optional()
    .catch(undefined),
  findings: z.array(z.unknown()).optional().catch([]),
  redactedPaths: z.array(z.string()).optional().catch([]),
});

export type ParsedStoredEvidence =
  | { format: "none" }
  | { format: "unrecognized" }
  | {
      format: "v1";
      checkedAt: string | null;
      outcome: ValidationStatus | null;
      reasonCode: string | null;
      scopeCovers: string | null;
      scopeMatchedPath: string | null;
      specApiSpecId: string | null;
      specSourceSha256: string | null;
      findings: ValidationEvidenceItem[];
      redactedPaths: string[];
    }
  | {
      format: "legacy";
      findings: ValidationEvidenceItem[];
      redactedPaths: string[];
    };

function toValidationStatus(value: string | null | undefined): ValidationStatus | null {
  if (!value) return null;
  if (Object.values(ValidationStatus).includes(value as ValidationStatus)) {
    return value as ValidationStatus;
  }
  return null;
}

function readFindings(items: unknown[]): ValidationEvidenceItem[] {
  const findings: ValidationEvidenceItem[] = [];
  for (const item of items) {
    const parsed = findingSchema.safeParse(item);
    if (parsed.success) {
      findings.push(parsed.data);
    }
  }
  return findings;
}

export function parseStoredValidationEvidence(raw: unknown): ParsedStoredEvidence {
  if (raw === null || raw === undefined) {
    return { format: "none" };
  }

  if (Array.isArray(raw)) {
    return { format: "legacy", findings: readFindings(raw), redactedPaths: [] };
  }

  const v1 = v1Schema.safeParse(raw);
  if (!v1.success) {
    return { format: "unrecognized" };
  }

  const data = v1.data;
  return {
    format: "v1",
    checkedAt: data.checkedAt ?? null,
    outcome: toValidationStatus(data.outcome ?? null),
    reasonCode: data.reasonCode ?? null,
    scopeCovers: data.scope?.covers ?? null,
    scopeMatchedPath: data.scope?.matchedPath ?? null,
    specApiSpecId: data.specRevision?.apiSpecId ?? null,
    specSourceSha256: data.specRevision?.sourceSha256 ?? null,
    findings: readFindings(data.findings ?? []),
    redactedPaths: data.redactedPaths ?? [],
  };
}
