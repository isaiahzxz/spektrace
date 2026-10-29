import { describe, expect, it } from "vitest";
import { historicalBindingImportSchema, historicalSelectionReason, millisecondUtcTimestamp } from "@/lib/specs/historical-revisions";

describe("historical contract time and ambiguity policy", () => {
  it.each(["2026-02-30T00:00:00.000Z", "2026-01-01T00:00:00.0001Z", "2026-01-01T00:00:00+01:00", "not a date"])("rejects non-round-trippable time %s", (time) => {
    expect(millisecondUtcTimestamp.safeParse(time).success).toBe(false);
  });
  it("requires a positive finite interval and rejects caller-defined authority and workspace", () => {
    const valid = { integrationKey: "synthetic-ci", sourceIntervalId: "window-1", sourceDeploymentId: "deploy-1", apiKey: "payments",
      environment: "default", apiSpecId: "d6ed8a43-6830-43ae-88d9-674ad3a83bf7", sourceSha256: "a".repeat(64),
      validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2026-01-02T00:00:00.000Z" };
    expect(historicalBindingImportSchema.safeParse(valid).success).toBe(true);
    for (const patch of [{ validUntil: valid.validFrom }, { validUntil: "2025-12-31T00:00:00.000Z" },
      { workspaceId: valid.apiSpecId }, { runtimeVerified: true }, { validUntil: null }])
      expect(historicalBindingImportSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
  it("does not substitute active revision for missing, ambiguous, overflow or future coverage", () => {
    const now = new Date("2026-01-02T00:00:00.000Z"); const time = "2026-01-01T00:00:00.000Z";
    expect(historicalSelectionReason(time, now, 0)).toBe("HISTORICAL_COVERAGE_MISSING");
    expect(historicalSelectionReason(time, now, 1)).toBe("HISTORICAL_BINDING_SELECTED");
    expect(historicalSelectionReason(time, now, 2)).toBe("HISTORICAL_COVERAGE_AMBIGUOUS");
    expect(historicalSelectionReason(time, now, 33)).toBe("HISTORICAL_CANDIDATE_LIMIT");
    expect(historicalSelectionReason("2026-01-02T00:05:00.001Z", now, 1)).toBe("HISTORICAL_OCCURRENCE_INVALID");
    expect(historicalSelectionReason("2026-01-02T00:00:00.001Z", now, 1)).toBe("HISTORICAL_OCCURRENCE_INVALID");
  });
});
