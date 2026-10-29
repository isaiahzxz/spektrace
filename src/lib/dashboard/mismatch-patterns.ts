import { findingsOf, parseValidationEvidence } from "@/lib/dashboard/evidence-adapter";

export type PatternSeverity = "CRITICAL" | "HIGH" | "LOW" | "UNRATED";

export type MismatchPattern = {
  key: string;
  path: string;
  rule: string;
  expected: string;
  method: string;
  operationPath: string;
  frequency: number;
  specLabel: string;
  severity: PatternSeverity;
  severityProvenance: "manual" | "unassigned";
  exampleIncidentId: string;
};

export type PatternSample = {
  patterns: MismatchPattern[];
  sampled: number;
  total: number;
};

/**
 * Pattern identity is specification, HTTP method, operation path, field,
 * rule, and expected constraint, joined by U+001F. Frequency counts distinct incidents.
 * Severity is never derived from frequency or the schema keyword.
 */
export function patternIdentity(input: {
  specId: string | null;
  method: string;
  operationPath: string;
  fieldPath: string;
  rule: string;
  expected: string;
}) {
  return [
    input.specId ?? "none",
    input.method.toUpperCase(),
    input.operationPath,
    input.fieldPath,
    input.rule,
    input.expected,
  ].join("\u001f");
}

export function aggregateMismatchPatterns(
  incidents: Array<{
    id: string;
    httpMethod: string;
    requestPath: string;
    validationEvidence: unknown;
    spec: { id: string; name: string; version: string } | null;
  }>,
  total: number,
  severities: Record<string, PatternSeverity> = {},
): PatternSample {
  const groups = new Map<
    string,
    {
      path: string;
      rule: string;
      expected: string;
      method: string;
      operationPath: string;
      specLabel: string;
      incidents: Set<string>;
    }
  >();

  for (const incident of incidents) {
    const specLabel = incident.spec
      ? `${incident.spec.name} ${incident.spec.version}`
      : "No pinned spec";
    const seen = new Set<string>();
    for (const finding of findingsOf(parseValidationEvidence(incident.validationEvidence))) {
      const key = patternIdentity({
        specId: incident.spec?.id ?? null,
        method: incident.httpMethod,
        operationPath: incident.requestPath,
        fieldPath: finding.path,
        rule: finding.rule,
        expected: finding.expected,
      });
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key) ?? {
        path: finding.path,
        rule: finding.rule,
        expected: finding.expected,
        method: incident.httpMethod,
        operationPath: incident.requestPath,
        specLabel,
        incidents: new Set<string>(),
      };
      group.incidents.add(incident.id);
      groups.set(key, group);
    }
  }

  const patterns = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      path: group.path,
      rule: group.rule,
      expected: group.expected,
      method: group.method,
      operationPath: group.operationPath,
      frequency: group.incidents.size,
      specLabel: group.specLabel,
      severity: severities[key] ?? "UNRATED",
      severityProvenance: severities[key] ? ("manual" as const) : ("unassigned" as const),
      exampleIncidentId: [...group.incidents][0] ?? "",
    }))
    .sort((a, b) => b.frequency - a.frequency || a.path.localeCompare(b.path))
    .slice(0, 8);

  return { patterns, sampled: incidents.length, total };
}
