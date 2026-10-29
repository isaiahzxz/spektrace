import { z } from "zod";

/**
 * Reads the validation evidence formats stored in `incidents.validation_evidence`:
 * - legacy: a bare array of findings (written by the original seed)
 * - v1: the versioned `ValidationEvidenceV1` object written by the worker
 * Anything else is reported as unrecognized instead of guessed at.
 */

export type FindingView = {
  keyword: string;
  path: string;
  pathNote: string | null;
  rule: string;
  expected: string;
  received: string;
  message: string;
  schemaPath: string;
};

export type EvidenceScopeView = {
  label: string | null;
  covers: string | null;
  openApiVersion: string | null;
  matchedPath: string | null;
  matchedMethod: string | null;
};

export type ParsedEvidence =
  | { format: "none" }
  | { format: "unrecognized" }
  | {
      format: "legacy-findings";
      findings: FindingView[];
      unreadableFindings: number;
    }
  | {
      format: "v1";
      checkedAt: string | null;
      outcome: string | null;
      reasonCode: string | null;
      reasonMessage: string | null;
      plainEnglishSummary: string | null;
      scope: EvidenceScopeView | null;
      specRevision: { apiSpecId: string | null; sourceSha256: string | null } | null;
      validator: { engine: string | null; schemaDialect: string | null } | null;
      findings: FindingView[];
      unreadableFindings: number;
      redactedPaths: string[];
    };

const NOT_RECORDED = "not recorded";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const findingSchema = z.object({
  jsonPointer: z.string(),
  keyword: z.string(),
  schemaPath: z.string().catch(""),
  message: z.string().catch(""),
  expected: z.string().optional().catch(undefined),
  observedType: z.string().optional().catch(undefined),
  missingProperty: z.string().optional().catch(undefined),
  additionalProperty: z.string().optional().catch(undefined),
  allowedValues: z.array(scalar).optional().catch(undefined),
});

type StoredFinding = z.infer<typeof findingSchema>;

const nullableString = z.string().nullable().optional().catch(null);

const v1Schema = z.object({
  version: z.literal(1),
  checkedAt: nullableString,
  outcome: nullableString,
  reasonCode: nullableString,
  reasonMessage: nullableString,
  plainEnglishSummary: nullableString,
  scope: z
    .object({
      label: nullableString,
      covers: nullableString,
      openApiVersion: nullableString,
      matchedPath: nullableString,
      matchedMethod: nullableString,
    })
    .nullable()
    .optional()
    .catch(null),
  specRevision: z
    .object({ apiSpecId: nullableString, sourceSha256: nullableString })
    .nullable()
    .optional()
    .catch(null),
  validator: z
    .object({ engine: nullableString, schemaDialect: nullableString })
    .nullable()
    .optional()
    .catch(null),
  findings: z.array(z.unknown()),
  redactedPaths: z.array(z.string()).optional().catch([]),
});

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function childPointer(base: string, property: string): string {
  const parent = base === "/" ? "" : base;
  return `${parent}/${escapePointerSegment(property)}`;
}

/** Ajv's fixed wording for `required`: must have required property 'name' */
function missingPropertyFromMessage(message: string): string | undefined {
  const match = /^must have required property '(.+)'$/.exec(message);
  return match?.[1];
}

function formatAllowed(values: Array<string | number | boolean | null>): string {
  return values.map((v) => JSON.stringify(v)).join(", ");
}

function toFindingView(finding: StoredFinding): FindingView {
  const base = finding.jsonPointer === "" ? "/" : finding.jsonPointer;
  const received = finding.observedType ?? NOT_RECORDED;
  const common = {
    keyword: finding.keyword,
    message: finding.message,
    schemaPath: finding.schemaPath,
  };

  switch (finding.keyword) {
    case "type":
      return {
        ...common,
        path: base,
        pathNote: null,
        rule: "Type",
        expected: finding.expected ?? finding.message,
        received,
      };
    case "required": {
      const name =
        finding.missingProperty ?? missingPropertyFromMessage(finding.message);
      return {
        ...common,
        path: name ? childPointer(base, name) : base,
        pathNote: name ? null : "A required field is missing from this object.",
        rule: "Required field",
        expected: "Field must be present",
        received: "Field is missing",
      };
    }
    case "additionalProperties": {
      const name = finding.additionalProperty;
      return {
        ...common,
        path: name ? childPointer(base, name) : base,
        pathNote: name
          ? null
          : "This object contains a field the schema does not allow. The field name was not recorded.",
        rule: "No extra fields",
        expected: "Only fields defined in the schema",
        received: "Unexpected field present",
      };
    }
    case "enum":
    case "const":
      return {
        ...common,
        path: base,
        pathNote: null,
        rule: "Allowed values",
        expected: finding.allowedValues
          ? `One of: ${formatAllowed(finding.allowedValues)}`
          : finding.message,
        received,
      };
    default:
      return {
        ...common,
        path: base,
        pathNote: null,
        rule: finding.keyword,
        expected: finding.message || NOT_RECORDED,
        received,
      };
  }
}

function readFindings(items: unknown[]): {
  findings: FindingView[];
  unreadableFindings: number;
} {
  const findings: FindingView[] = [];
  let unreadableFindings = 0;
  for (const item of items) {
    const parsed = findingSchema.safeParse(item);
    if (parsed.success) {
      findings.push(toFindingView(parsed.data));
    } else {
      unreadableFindings += 1;
    }
  }
  return { findings, unreadableFindings };
}

export function parseValidationEvidence(raw: unknown): ParsedEvidence {
  if (raw === null || raw === undefined) {
    return { format: "none" };
  }

  if (Array.isArray(raw)) {
    return { format: "legacy-findings", ...readFindings(raw) };
  }

  const v1 = v1Schema.safeParse(raw);
  if (!v1.success) {
    return { format: "unrecognized" };
  }

  const data = v1.data;
  return {
    format: "v1",
    checkedAt: data.checkedAt ?? null,
    outcome: data.outcome ?? null,
    reasonCode: data.reasonCode ?? null,
    reasonMessage: data.reasonMessage ?? null,
    plainEnglishSummary: data.plainEnglishSummary ?? null,
    scope: data.scope
      ? {
          label: data.scope.label ?? null,
          covers: data.scope.covers ?? null,
          openApiVersion: data.scope.openApiVersion ?? null,
          matchedPath: data.scope.matchedPath ?? null,
          matchedMethod: data.scope.matchedMethod ?? null,
        }
      : null,
    specRevision: data.specRevision
      ? {
          apiSpecId: data.specRevision.apiSpecId ?? null,
          sourceSha256: data.specRevision.sourceSha256 ?? null,
        }
      : null,
    validator: data.validator
      ? {
          engine: data.validator.engine ?? null,
          schemaDialect: data.validator.schemaDialect ?? null,
        }
      : null,
    ...readFindings(data.findings),
    redactedPaths: data.redactedPaths ?? [],
  };
}

export function findingsOf(evidence: ParsedEvidence): FindingView[] {
  return evidence.format === "v1" || evidence.format === "legacy-findings"
    ? evidence.findings
    : [];
}
