export type EvidenceProgramInput = {
  method: string;
  path: string;
  statusCode: string;
  validationLabel: string;
  explanation: string;
  findings: { path: string; expected: string; received: string; rule: string }[];
  specName: string;
  specVersion: string;
};

/** Quote a value for an OpenUI Lang string argument. */
export function openUiString(value: string) {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}"`;
}

function findingLine(finding: EvidenceProgramInput["findings"][number]) {
  return `${finding.path} | ${finding.rule} | expected ${finding.expected} | received ${finding.received}`;
}

/**
 * Application-authored OpenUI Lang. Values are arguments, never inserted as markup.
 */
/** Overview program: identity, finding, and the expected-versus-received line. */
export function buildCompactIncidentProgram(input: EvidenceProgramInput & { incidentId: string }) {
  const [first, ...rest] = input.findings;
  const line = first
    ? findingLine(first) + (rest.length > 0 ? ` · ${rest.length} more stored comparisons` : "")
    : "";
  const rows = line ? openUiString(line) : "";
  return [
    `summary = IncidentSummary(${openUiString(input.method)}, ${openUiString(input.path)}, ${openUiString(input.statusCode)}, ${openUiString(input.validationLabel)})`,
    `findings = FindingList([${rows}])`,
    `root = CompactEvidence(${openUiString(input.incidentId)}, summary, findings)`,
  ].join("\n");
}

export function buildIncidentProgram(input: EvidenceProgramInput) {
  const rows = input.findings.map((finding) => openUiString(findingLine(finding))).join(", ");
  return [
    `summary = IncidentSummary(${openUiString(input.method)}, ${openUiString(input.path)}, ${openUiString(input.statusCode)}, ${openUiString(input.validationLabel)})`,
    `explanation = StoredExplanation(${openUiString(input.explanation)})`,
    `findings = FindingList([${rows}])`,
    `spec = SpecReference(${openUiString(input.specName)}, ${openUiString(input.specVersion)})`,
    "root = IncidentEvidence(summary, explanation, findings, spec)",
  ].join("\n");
}
