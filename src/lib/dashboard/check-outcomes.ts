import type { IncidentStatus, ValidationStatus } from "@/generated/prisma/enums";
import { statusCategory } from "@/lib/dashboard/incident-status";

export type CheckOutcomes = {
  passed: number;
  mismatch: number;
  unsupported: number;
  failed: number;
  pending: number;
};

export function tallyCheckOutcomes(
  rows: { status: IncidentStatus; validationStatus: ValidationStatus; count: number }[],
): CheckOutcomes {
  const totals: CheckOutcomes = {
    passed: 0,
    mismatch: 0,
    unsupported: 0,
    failed: 0,
    pending: 0,
  };
  for (const row of rows) {
    const category = statusCategory(row.status, row.validationStatus);
    if (category === "failed") totals.failed += row.count;
    else if (category === "pending") totals.pending += row.count;
    else if (row.validationStatus === "PASSED") totals.passed += row.count;
    else if (row.validationStatus === "MISMATCH") totals.mismatch += row.count;
    else if (row.validationStatus === "UNSUPPORTED") totals.unsupported += row.count;
  }
  return totals;
}

/**
 * Validation outcome only. This is not the human-review queue.
 * Pending checks are still running and are counted separately.
 */
export function unsupportedOrFailedCount(outcomes: CheckOutcomes) {
  return outcomes.unsupported + outcomes.failed;
}

/**
 * Workflow statuses that still require a person.
 * NEEDS_REVIEW is written for every finished check, including a confirmed
 * mismatch and a passing body check. A passing body check does not resolve
 * the original 4xx. APPROVED is the human decision and is excluded.
 * RECEIVED and VALIDATING are still in automated processing.
 */
const AWAITING_REVIEW = new Set<IncidentStatus>(["NEEDS_REVIEW", "DRAFT_READY"]);

export function awaitingHumanReviewCount(
  rows: { status: IncidentStatus; count: number }[],
) {
  return rows.reduce(
    (sum, row) => (AWAITING_REVIEW.has(row.status) ? sum + row.count : sum),
    0,
  );
}
