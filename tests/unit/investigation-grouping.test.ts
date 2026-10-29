import { describe, expect, it } from "vitest";
import { ValidationStatus } from "@/generated/prisma/client";
import { computeFindingSignature } from "@/lib/investigation/finding-signature";
import { groupingWindowForReceivedAt } from "@/lib/investigation/grouping-window";
import { INVESTIGATION_GROUPING_WINDOW_MS } from "@/lib/investigation/config";
import { VALIDATION_EVIDENCE_VERSION } from "@/lib/validation/validation-evidence-v1";

describe("investigation grouping policy", () => {
  it("aligns grouping windows to fixed 15-minute UTC buckets", () => {
    const receivedAt = new Date("2026-01-15T10:07:30.000Z");
    const window = groupingWindowForReceivedAt(receivedAt);
    expect(window.start.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-01-15T10:15:00.000Z");
    expect(window.end.getTime() - window.start.getTime()).toBe(
      INVESTIGATION_GROUPING_WINDOW_MS,
    );
  });

  it("places incidents on opposite sides of a window boundary in separate buckets", () => {
    const before = groupingWindowForReceivedAt(new Date("2026-01-15T10:14:59.999Z"));
    const after = groupingWindowForReceivedAt(new Date("2026-01-15T10:15:00.000Z"));
    expect(before.end.toISOString()).toBe("2026-01-15T10:15:00.000Z");
    expect(after.start.toISOString()).toBe("2026-01-15T10:15:00.000Z");
    expect(before.start.getTime()).not.toBe(after.start.getTime());
  });

  it("uses explicit outcome signatures for passed and unsupported checks", () => {
    const passed = computeFindingSignature(ValidationStatus.PASSED, {
      version: VALIDATION_EVIDENCE_VERSION,
      outcome: ValidationStatus.PASSED,
      findings: [],
    });
    expect(passed).toBe("outcome:passed");

    const unsupported = computeFindingSignature(ValidationStatus.UNSUPPORTED, {
      version: VALIDATION_EVIDENCE_VERSION,
      outcome: ValidationStatus.UNSUPPORTED,
      reasonCode: "REDACTION_BLOCKED_VALIDATION",
      findings: [],
    });
    expect(unsupported).toBe("outcome:unsupported:REDACTION_BLOCKED_VALIDATION");
  });

  it("distinguishes mismatch signatures by field, rule, and expected constraint", () => {
    const amountMismatch = computeFindingSignature(ValidationStatus.MISMATCH, {
      version: VALIDATION_EVIDENCE_VERSION,
      outcome: ValidationStatus.MISMATCH,
      findings: [
        {
          jsonPointer: "/amount",
          keyword: "type",
          schemaPath: "#/properties/amount/type",
          message: "must be integer",
          expected: "integer",
        },
      ],
    });

    const otherField = computeFindingSignature(ValidationStatus.MISMATCH, {
      version: VALIDATION_EVIDENCE_VERSION,
      outcome: ValidationStatus.MISMATCH,
      findings: [
        {
          jsonPointer: "/currency",
          keyword: "type",
          schemaPath: "#/properties/currency/type",
          message: "must be string",
          expected: "string",
        },
      ],
    });

    expect(amountMismatch).not.toBe(otherField);
    expect(amountMismatch).toContain("/amount");
    expect(otherField).toContain("/currency");
  });
});
