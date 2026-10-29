import { ValidationStatus } from "@/generated/prisma/client";
import type { InvestigationInferenceAdapter } from "@/lib/investigation/inference/adapters/types";
import type { InvestigationModelInput } from "@/lib/investigation/inference/rebuild-inference-input";

function mismatchExplanation(input: InvestigationModelInput) {
  const primary = input.evidenceItems[0];
  const finding = primary?.findings[0];
  const field = finding?.jsonPointer ?? "an omitted field";
  const constraint =
    finding?.constraints.find((row) => row.kind === "expected_json_type")?.expectedJsonType ??
    finding?.ruleKeyword ??
    "schema rule";
  const repoContext =
    input.version === 2 || input.version === 3 || input.version === 4
      ? input.repositoryContext ?? null
      : null;
  const repoExcerpt = repoContext?.excerpts[0] ?? null;
  const docContext =
    input.version === 3 || input.version === 4 ? input.documentationContext ?? null : null;
  const docExcerpt = docContext?.excerpts[0] ?? null;
  const deployContext = input.version === 4 ? input.deploymentContext ?? null : null;
  const deployRecord = deployContext?.records[0] ?? null;
  const repoFinding = repoExcerpt && repoContext
    ? {
        description: `The selected repository snapshot (${repoContext.repository}@${repoContext.commitSha.slice(0, 7)}) contains client code referencing ${field} in ${repoExcerpt.relativeFilePath}. This describes serialization/shape only and does not establish production causation.`,
        citationIds: [repoExcerpt.id],
      }
    : null;
  const docFinding = docExcerpt
    ? {
        description: `Approved documentation (${docExcerpt.title}, section "${docExcerpt.sectionHeading}") describes ${field} as advisory guidance only. It does not override the pinned OpenAPI specification or deterministic validation findings.`,
        citationIds: [docExcerpt.id],
      }
    : null;
  const deployFinding = deployRecord
    ? {
        description: `A deployment with status ${deployRecord.status} was recorded at ${deployRecord.sourceReportedAt} before the incident reference time. This is temporal context only and is not evidence that the deployment event explains the validation mismatch.`,
        citationIds: [deployRecord.id],
      }
    : null;
  return {
    summary: `Across ${input.groupedIncidentCount} grouped incident(s), contract validation recorded a ${finding?.ruleKeyword ?? "schema"} mismatch on ${field}.`,
    observedFindings: [
      {
        description: `Protected evidence shows ${field} did not satisfy ${constraint} (${finding?.schemaRulePath ?? "rule path omitted"}).`,
        citationIds: primary ? [primary.id] : [],
      },
      ...(repoFinding ? [repoFinding] : []),
      ...(docFinding ? [docFinding] : []),
      ...(deployFinding ? [deployFinding] : []),
    ],
    evidenceCitations: [
      ...input.evidenceItems.map((item) => ({
        id: item.id,
        label: `Incident evidence (${item.validationStatus})`,
      })),
      ...(repoExcerpt
        ? [
            {
              id: repoExcerpt.id,
              label: `${repoExcerpt.relativeFilePath}:${repoExcerpt.startLine}-${repoExcerpt.endLine}`,
            },
          ]
        : []),
      ...(docExcerpt
        ? [
            {
              id: docExcerpt.id,
              label: `${docExcerpt.documentId}:${docExcerpt.sectionHeading}`,
            },
          ]
        : []),
      ...(deployRecord
        ? [
            {
              id: deployRecord.id,
              label: `${deployRecord.sourceDeploymentRef}:${deployRecord.status}`,
            },
          ]
        : []),
    ],
    limitations: [
      "This explanation is generated from contract-validation evidence only.",
      "It does not establish why the upstream service returned a particular HTTP response.",
      ...(repoContext ? repoContext.limitations : []),
      ...(docContext ? docContext.limitations : []),
      ...(deployContext ? deployContext.limitations : []),
    ],
    missingContext: input.unavailableEvidenceCount > 0
      ? [`${input.unavailableEvidenceCount} prepared incident bundle(s) could not be rebuilt.`]
      : ["Runtime logs and deployment state were not supplied."],
    suggestedSteps: [
      "Compare the cited field against the pinned OpenAPI request schema.",
      "Confirm client payloads across the grouped incidents match the cited constraint.",
    ],
  };
}

function uncertainExplanation(input: InvestigationModelInput, status: ValidationStatus) {
  return {
    summary: `Grouped incidents (${input.groupedIncidentCount}) have validation status ${status}. Available contract evidence does not establish the upstream failure cause.`,
    observedFindings: [
      {
        description: `Validation outcome is ${status}; no mismatch findings were available to explain production impact.`,
        citationIds: [input.evidenceItems[0]!.id],
      },
    ],
    evidenceCitations: input.evidenceItems.map((item) => ({
      id: item.id,
      label: `Incident evidence (${item.validationStatus})`,
    })),
    limitations: [
      "Contract evidence alone cannot explain this failure mode.",
      "Generated text requires human review before action.",
    ],
    missingContext: ["Upstream service behavior and deployment context are not in scope."],
    suggestedSteps: [
      "Review raw incident metadata and logs outside SpekTrace.",
      "Confirm the active OpenAPI revision covers the reported operation.",
    ],
  };
}

export function createTestInferenceAdapter(): InvestigationInferenceAdapter {
  return {
    kind: "test",
    providerLabel: "spektrace-test",
    modelLabel: "deterministic-fixture",
    async complete(input) {
      if (process.env.SPEKTRACE_AI_TEST_ADAPTER_FORCE_MALFORMED === "1") {
        return { ok: true, rawJson: { summary: "bad", extra: true }, provider: "spektrace-test", model: "deterministic-fixture" };
      }
      if (process.env.SPEKTRACE_AI_TEST_ADAPTER_FORCE_UNKNOWN_CITATION === "1") {
        return {
          ok: true,
          rawJson: {
            ...mismatchExplanation(input),
            observedFindings: [{ description: "bad cite", citationIds: ["ev-deadbeef"] }],
          },
          provider: "spektrace-test",
          model: "deterministic-fixture",
        };
      }

      const status = input.validationOutcome;
      const rawJson =
        status === ValidationStatus.MISMATCH
          ? mismatchExplanation(input)
          : uncertainExplanation(input, status);

      return {
        ok: true,
        rawJson,
        provider: "spektrace-test",
        model: "deterministic-fixture",
      };
    },
  };
}
