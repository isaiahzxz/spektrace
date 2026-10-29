import type { IncidentStatus, ValidationStatus } from "@/generated/prisma/enums";
import type { FindingView } from "@/lib/dashboard/evidence-adapter";

export type QueueFilter = "all" | "pending" | "triaged" | "history";

/**
 * - pending: received, being checked, or not checked yet
 * - triaged: the automated check finished with a result (no human approval implied)
 * - unsupported: the check finished, but the request was outside implemented coverage
 * - failed: a technical failure stopped the check
 */
export type StatusCategory = "pending" | "triaged" | "unsupported" | "failed";

const PENDING_WORKFLOW: ReadonlySet<IncidentStatus> = new Set([
  "RECEIVED",
  "VALIDATING",
]);

export function statusCategory(
  status: IncidentStatus,
  validationStatus: ValidationStatus,
): StatusCategory {
  if (status === "FAILED" || validationStatus === "ERROR") {
    return "failed";
  }
  if (PENDING_WORKFLOW.has(status) || validationStatus === "NOT_RUN") {
    return "pending";
  }
  if (validationStatus === "UNSUPPORTED") {
    return "unsupported";
  }
  return "triaged";
}

export const CATEGORY_LABEL: Record<StatusCategory, string> = {
  pending: "Pending",
  triaged: "Triaged",
  unsupported: "Needs review",
  failed: "Check failed",
};

/** Which queue filter tab a category belongs to. Failed checks appear under All only. */
export function filterIncludesCategory(
  filter: QueueFilter,
  category: StatusCategory,
): boolean {
  if (filter === "all") return true;
  if (filter === "pending") return category === "pending";
  return category === "triaged" || category === "unsupported";
}

export const WORKFLOW_LABEL: Record<IncidentStatus, string> = {
  RECEIVED: "Received",
  VALIDATING: "Checking",
  NEEDS_REVIEW: "Awaiting human review",
  DRAFT_READY: "Draft ready",
  APPROVED: "Approved",
  SENDING: "Sending",
  SENT: "Sent",
  FAILED: "Failed",
};

export const VALIDATION_LABEL: Record<ValidationStatus, string> = {
  NOT_RUN: "Not checked yet",
  PASSED: "Body matched supported schema",
  MISMATCH: "Schema mismatch",
  UNSUPPORTED: "Unsupported check",
  ERROR: "Check failed",
};

export type DriftTone = "mismatch" | "neutral" | "muted" | "failed";

export type DriftLabel = { label: string; tone: DriftTone };

const KEYWORD_DRIFT: Record<string, string> = {
  type: "Type mismatch",
  required: "Missing required field",
  additionalProperties: "Unexpected field",
  enum: "Enum mismatch",
  const: "Enum mismatch",
};

export function driftLabel(
  category: StatusCategory,
  validationStatus: ValidationStatus,
  findings: FindingView[],
): DriftLabel {
  if (category === "failed") return { label: "Check failed", tone: "failed" };
  if (category === "pending") return { label: "Awaiting check", tone: "muted" };
  if (category === "unsupported") return { label: "Unsupported check", tone: "muted" };
  if (validationStatus === "PASSED") return { label: "No body mismatch", tone: "neutral" };

  if (findings.length > 1) {
    return { label: `Multiple mismatches (${findings.length})`, tone: "mismatch" };
  }
  const [only] = findings;
  if (!only) {
    return { label: "Schema mismatch (details unavailable)", tone: "mismatch" };
  }
  return {
    label: KEYWORD_DRIFT[only.keyword] ?? "Other schema rule",
    tone: "mismatch",
  };
}
