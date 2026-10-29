/** Hard limits for agent-facing evidence bundles (UTF-8 serialized JSON). */
export const AGENT_EVIDENCE_LIMITS = {
  maxBundleUtf8Bytes: 16_384,
  maxFindings: 32,
  maxOmissions: 24,
  maxRedactedPathEntries: 32,
  maxJsonPointerLength: 256,
  maxSchemaRulePathLength: 256,
  maxRuleKeywordLength: 64,
  maxReasonCodeLength: 128,
  maxOmissionReasonLength: 256,
  maxSafeIdentifierLength: 64,
  maxConstraintDepth: 3,
  maxOpenApiPathLength: 512,
} as const;
