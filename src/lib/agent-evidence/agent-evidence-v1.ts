import { z } from "zod";
import { ValidationStatus } from "@/generated/prisma/client";
import { AGENT_EVIDENCE_LIMITS } from "@/lib/agent-evidence/limits";

export const AGENT_EVIDENCE_VERSION = 1;

const shortString = z.string().max(AGENT_EVIDENCE_LIMITS.maxReasonCodeLength);

const schemaConstraintSchema: z.ZodType<AgentSchemaConstraintV1> = z.lazy(() =>
  z
    .object({
      kind: z.enum([
        "expected_json_type",
        "required_property",
        "unexpected_property",
        "enum_value_count",
      ]),
      expectedJsonType: shortString.optional(),
      propertyName: shortString.optional(),
      allowedValueCount: z.number().int().min(0).max(10_000).optional(),
    })
    .strict(),
);

export type AgentSchemaConstraintV1 = {
  kind:
    | "expected_json_type"
    | "required_property"
    | "unexpected_property"
    | "enum_value_count";
  expectedJsonType?: string;
  propertyName?: string;
  allowedValueCount?: number;
};

export type AgentFindingV1 = {
  jsonPointer: string;
  ruleKeyword: string;
  schemaRulePath: string;
  observedJsonType: string | null;
  constraints: AgentSchemaConstraintV1[];
};

export type AgentOmissionV1 = {
  code: string;
  reason: string;
};

export type AgentEvidenceBundleV1 = {
  version: typeof AGENT_EVIDENCE_VERSION;
  incident: { id: string };
  service: { apiKey: string; environment: string };
  http: {
    method: string;
    statusCode: number;
    operationPath: string | null;
    operationPathOmissionCode: string | null;
  };
  specRevision: {
    apiSpecId: string | null;
    sourceSha256: string | null;
  };
  validation: {
    status: ValidationStatus;
    reasonCode: string | null;
    scopeCovers: string | null;
    checkedAt: string | null;
  };
  findings: AgentFindingV1[];
  protection: {
    redactedPathCount: number;
    evidenceComplete: boolean;
    redactionBlockedValidation: boolean;
    omissions: AgentOmissionV1[];
    outputTruncated: boolean;
  };
};

export const agentEvidenceBundleSchema = z
  .object({
    version: z.literal(AGENT_EVIDENCE_VERSION),
    incident: z.object({ id: z.string().uuid() }).strict(),
    service: z
      .object({
        apiKey: z.string().min(1).max(128),
        environment: z.string().min(1).max(64),
      })
      .strict(),
    http: z
      .object({
        method: z.string().min(1).max(16),
        statusCode: z.number().int().min(400).max(499),
        operationPath: z.string().max(AGENT_EVIDENCE_LIMITS.maxOpenApiPathLength).nullable(),
        operationPathOmissionCode: shortString.nullable(),
      })
      .strict(),
    specRevision: z
      .object({
        apiSpecId: z.string().uuid().nullable(),
        sourceSha256: z.string().max(128).nullable(),
      })
      .strict(),
    validation: z
      .object({
        status: z.nativeEnum(ValidationStatus),
        reasonCode: shortString.nullable(),
        scopeCovers: z.string().max(64).nullable(),
        checkedAt: z.string().datetime().nullable(),
      })
      .strict(),
    findings: z.array(
      z
        .object({
          jsonPointer: z.string().max(AGENT_EVIDENCE_LIMITS.maxJsonPointerLength),
          ruleKeyword: z.string().max(AGENT_EVIDENCE_LIMITS.maxRuleKeywordLength),
          schemaRulePath: z.string().max(AGENT_EVIDENCE_LIMITS.maxSchemaRulePathLength),
          observedJsonType: z.string().max(32).nullable(),
          constraints: z.array(schemaConstraintSchema).max(AGENT_EVIDENCE_LIMITS.maxConstraintDepth),
        })
        .strict(),
    ),
    protection: z
      .object({
        redactedPathCount: z.number().int().min(0),
        evidenceComplete: z.boolean(),
        redactionBlockedValidation: z.boolean(),
        omissions: z
          .array(
            z
              .object({
                code: shortString,
                reason: z.string().max(AGENT_EVIDENCE_LIMITS.maxOmissionReasonLength),
              })
              .strict(),
          )
          .max(AGENT_EVIDENCE_LIMITS.maxOmissions),
        outputTruncated: z.boolean(),
      })
      .strict(),
  })
  .strict();

export function parseAgentEvidenceBundle(
  value: unknown,
): { ok: true; bundle: AgentEvidenceBundleV1 } | { ok: false } {
  const parsed = agentEvidenceBundleSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false };
  }
  return { ok: true, bundle: parsed.data };
}
