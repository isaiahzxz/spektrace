import { z } from "zod";

export const HISTORICAL_REVISION_CANDIDATE_LIMIT = 32;
export const REVISION_SELECTION_VERSION = "historical-binding@1";

// All API times round-trip exactly through JavaScript and timestamptz(3).
export const millisecondUtcTimestamp = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
).refine((value) => !value.startsWith("0000-") && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  "Use a valid UTC timestamp with exactly three fractional digits");

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
export const historicalBindingImportSchema = z.object({
  integrationKey: identifier.max(64),
  sourceIntervalId: identifier,
  sourceDeploymentId: identifier,
  apiKey: identifier,
  environment: identifier.max(64),
  apiSpecId: z.string().uuid(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  validFrom: millisecondUtcTimestamp,
  validUntil: millisecondUtcTimestamp,
}).strict().refine((value) => Date.parse(value.validUntil) > Date.parse(value.validFrom), {
  message: "validUntil must be later than validFrom", path: ["validUntil"],
});
export type HistoricalBindingImport = z.infer<typeof historicalBindingImportSchema>;

export const historicalBindingAllowlistSchema = z.array(z.object({
  integrationKey: identifier.max(64), apiKey: identifier, environment: identifier.max(64),
}).strict()).max(100);

export type HistoricalSelectionReason = "HISTORICAL_BINDING_SELECTED" | "HISTORICAL_COVERAGE_MISSING"
  | "HISTORICAL_COVERAGE_AMBIGUOUS" | "HISTORICAL_CANDIDATE_LIMIT" | "HISTORICAL_OCCURRENCE_INVALID"
  | "HISTORICAL_BINDING_INVALID";

export function historicalSelectionReason(occurredAt: string, now: Date, candidateCount: number): HistoricalSelectionReason {
  if (!millisecondUtcTimestamp.safeParse(occurredAt).success || Date.parse(occurredAt) > now.getTime())
    return "HISTORICAL_OCCURRENCE_INVALID";
  if (candidateCount > HISTORICAL_REVISION_CANDIDATE_LIMIT) return "HISTORICAL_CANDIDATE_LIMIT";
  if (candidateCount === 0) return "HISTORICAL_COVERAGE_MISSING";
  if (candidateCount > 1) return "HISTORICAL_COVERAGE_AMBIGUOUS";
  return "HISTORICAL_BINDING_SELECTED";
}
