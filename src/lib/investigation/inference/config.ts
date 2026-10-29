export const INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION =
  "spektrace-investigation-explanation@36";

export const INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION_WITH_REPOSITORY =
  "spektrace-investigation-explanation@37";

export const INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION_WITH_DOCUMENTATION =
  "spektrace-investigation-explanation@38";

export const INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION_WITH_DEPLOYMENT =
  "spektrace-investigation-explanation@39-source-facts-v2";

export const INVESTIGATION_INFERENCE_LIMITS = {
  maxEvidenceInputUtf8Bytes: 96_000,
  maxOutputUtf8Bytes: 16_384,
  maxProviderCompletionTokens: 2_048,
  maxSummaryChars: 2_000,
  maxListItems: 20,
  maxCitationIdsPerItem: 12,
  providerTimeoutMs: 45_000,
  maxConcurrentRuns: 2,
  maxAttemptsPerPreparationRun: 3,
  retryBackoffMs: [2_000, 8_000, 30_000] as const,
} as const;

export type InferenceAdapterKind = "test" | "gateway" | "none";

export function resolveInferenceAdapterKind(): InferenceAdapterKind {
  const raw = process.env.SPEKTRACE_AI_INFERENCE_ADAPTER?.trim().toLowerCase();
  if (raw === "test" || raw === "gateway" || raw === "none") {
    return raw;
  }
  if (process.env.THESYS_API_KEY?.trim()) {
    return "gateway";
  }
  return "none";
}

export function isAiInvestigationEnabledForWorkspace(workspaceId: string): boolean {
  const flag = process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED?.trim().toLowerCase();
  if (flag !== "1" && flag !== "true" && flag !== "on") {
    return false;
  }
  const pilot = process.env.SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID?.trim();
  if (pilot) {
    return pilot === workspaceId;
  }
  const internal = process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID?.trim();
  if (internal) {
    return internal === workspaceId;
  }
  return false;
}

export function gatewayModelId(): string {
  const configured = process.env.SPEKTRACE_AI_GATEWAY_MODEL?.trim();
  return configured && configured.length > 0 ? configured : "openai/gpt-4.1-mini";
}

export function gatewayBaseUrl(): string {
  const configured = process.env.SPEKTRACE_AI_GATEWAY_BASE_URL?.trim();
  return configured && configured.length > 0
    ? configured.replace(/\/$/, "")
    : "https://api.thesys.dev/v1/embed";
}
