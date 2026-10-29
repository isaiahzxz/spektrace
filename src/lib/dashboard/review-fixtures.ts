import type { IncidentDetailView } from "@/lib/dashboard/incident-view-models";

/**
 * Labeled examples for states that are not in the local queue.
 * These are not stored incidents and are never written to the database.
 */

const scopeNote =
  "Example only. This is not a stored incident. The check covers the JSON request body only.";

function base(overrides: Partial<IncidentDetailView>): IncidentDetailView {
  return {
    id: "example-not-stored",
    httpMethod: "POST",
    requestPath: "/v1/payments",
    statusCode: 400,
    apiKey: "payments-api",
    environment: "default",
    source: "WEBHOOK",
    sourceEventId: "example",
    clientReference: null,
    category: "triaged",
    categoryLabel: "Triaged",
    workflowLabel: "Awaiting human review",
    validationLabel: "Schema mismatch",
    receivedAt: "2026-10-19 02:17:47 UTC",
    occurredAt: "2026-10-19 02:17:40 UTC",
    checkedAt: "2026-10-19 02:17:48 UTC",
    explanation: {
      state: "stored",
      heading: "Explanation",
      text: "Example explanation. This text is not from a stored incident.",
      reasonCode: "EXAMPLE",
    },
    body: { kind: "json", text: '{\n  "amount": 1\n}', isJsonNull: false },
    evidence: {
      format: "v1",
      findings: [],
      unreadableFindings: 0,
      scopeNote,
      checkedAt: "2026-10-19 02:17:48 UTC",
      validatorLabel: "example",
      redactedPaths: [],
      technicalJson: '{\n  "example": true\n}',
    },
    spec: {
      kind: "pinned",
      id: "example-revision",
      name: "Example Payments API",
      version: "1.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "example.openapi.yaml",
      sourceSha256: "example-checksum",
      isCurrentlyActive: true,
      evidenceChecksum: "matches",
    },
    processingError: null,
    ...overrides,
  };
}

export const REVIEW_FIXTURES = {
  long: base({
    requestPath: "/v1/organizations/example-org/billing/invoices/2026/line-items/amount",
    httpMethod: "PATCH",
  }),
  multi: base({
    explanation: {
      state: "stored",
      heading: "Explanation",
      text: "Example with three findings. This text is not from a stored incident.",
      reasonCode: "EXAMPLE",
    },
    evidence: {
      format: "v1",
      findings: [
        {
          keyword: "type",
          path: "/amount",
          pathNote: null,
          rule: "Type",
          expected: "integer",
          received: "string",
          message: "must be integer",
          schemaPath: "#/properties/amount/type",
        },
        {
          keyword: "required",
          path: "/currency",
          pathNote: null,
          rule: "Required field",
          expected: "Field must be present",
          received: "Field is missing",
          message: "must have required property 'currency'",
          schemaPath: "#/required",
        },
        {
          keyword: "additionalProperties",
          path: "/note",
          pathNote: null,
          rule: "No extra fields",
          expected: "Only fields defined in the schema",
          received: "Unexpected field present",
          message: "must NOT have additional properties",
          schemaPath: "#/additionalProperties",
        },
      ],
      unreadableFindings: 0,
      scopeNote,
      checkedAt: "2026-10-19 02:17:48 UTC",
      validatorLabel: "example",
      redactedPaths: [],
      technicalJson: '{\n  "example": "multiple findings"\n}',
    },
  }),
  failed: base({
    category: "failed",
    categoryLabel: "Check failed",
    workflowLabel: "Failed",
    validationLabel: "Check failed",
    explanation: {
      state: "failed",
      heading: "The check could not finish.",
      text: "Example failure. This text is not from a stored incident.",
      reasonCode: "EXAMPLE",
    },
    processingError: { code: "EXAMPLE_ERROR", message: "Example processing error. Nothing failed in the database." },
  }),
  pending: base({
    category: "pending",
    categoryLabel: "Pending",
    workflowLabel: "Received",
    validationLabel: "Not checked yet",
    checkedAt: null,
    explanation: {
      state: "pending",
      heading: "This request is waiting to be checked.",
      text: null,
      reasonCode: null,
    },
    evidence: {
      format: "none",
      findings: [],
      unreadableFindings: 0,
      scopeNote,
      checkedAt: null,
      validatorLabel: null,
      redactedPaths: [],
      technicalJson: null,
    },
  }),
  "missing-spec": base({
    category: "unsupported",
    categoryLabel: "Needs review",
    validationLabel: "Unsupported check",
    explanation: {
      state: "unsupported",
      heading: "This check is outside the currently supported rules.",
      text: "Example. No specification was selected.",
      reasonCode: "EXAMPLE",
    },
    spec: { kind: "none", reason: "Example. No API specification revision was selected for this incident." },
  }),
} as const;

export type ReviewFixtureKey = keyof typeof REVIEW_FIXTURES;

export function reviewFixture(value: string | undefined): IncidentDetailView | null {
  if (!value || !(value in REVIEW_FIXTURES)) return null;
  return REVIEW_FIXTURES[value as ReviewFixtureKey];
}
