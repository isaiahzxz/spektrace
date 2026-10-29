/** Documented limits for documentation-context import and excerpt export (stage 4B). */
export const DOCUMENTATION_CONTEXT_LIMITS = {
  maxDocumentsPerImport: 20,
  maxDocumentBytes: 256_000,
  maxTotalBytes: 512_000,
  maxDocumentIdLength: 128,
  maxTitleLength: 240,
  maxSourceKeyLength: 128,
  maxContentVersionLength: 64,
  maxExcerptsPerRetrieval: 6,
  maxExcerptLines: 32,
  maxExcerptUtf8Bytes: 4_000,
  maxAggregateExcerptUtf8Bytes: 12_000,
} as const;

export const DOCUMENTATION_FRESHNESS_NOTE =
  "Source-declared update time and import time do not prove documentation matches deployed behavior.";

export const DOCUMENTATION_AUTHORITY_NOTE =
  "Advisory documentation does not override the pinned OpenAPI specification or deterministic validation findings.";
