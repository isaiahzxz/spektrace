/** Fixed grouping window based on server `receivedAt` (UTC epoch-aligned buckets). */
export const INVESTIGATION_GROUPING_WINDOW_MS = 15 * 60 * 1000;

export const INVESTIGATION_PREPARATION_LIMITS = {
  maxIncidentsPerRun: 50,
  maxProtectedSummaryUtf8Bytes: 32_768,
} as const;

export const EVIDENCE_PREPARATION_BUILDER_VERSION = "spektrace-evidence-prep@1";

export function isEvidencePreparationEnabled(): boolean {
  const raw = process.env.SPEKTRACE_EVIDENCE_PREPARATION_ENABLED;
  if (raw === undefined || raw === "") {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}
