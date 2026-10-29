import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildAgentEvidenceBundle } from "@/server/services/build-agent-evidence";
import { resolveOpenApiJsonRequestBodySchema } from "@/lib/validation/resolve-openapi-request-schema";
import { validateJsonSchemaPayload } from "@/lib/validation/validate-json-schema";
import { createIntegerCandidate, proposalInputSchema, proposalPlanSchema, safeProposalBody, type ProposalAdapter } from "@/lib/payload-proposal/contract";
import { evaluateCandidate } from "./correction";

const storedEvidenceSchema = z.object({
  version: z.literal(1), checkedAt: z.string().datetime(), outcome: z.literal("MISMATCH"), reasonCode: z.literal("SCHEMA_MISMATCH"), reasonMessage: z.string().nullable(), plainEnglishSummary: z.string().nullable(),
  scope: z.object({ label: z.literal("openapi_request_body"), openApiVersion: z.string().nullable(), matchedPath: z.string(), matchedMethod: z.string(), covers: z.literal("json_request_body_only") }).strict(),
  specRevision: z.object({ apiSpecId: z.string().uuid(), sourceSha256: z.string() }).strict(),
  validator: z.object({ engine: z.literal("ajv"), schemaDialect: z.literal("https://json-schema.org/draft/2020-12/schema") }).strict(),
  findings: z.array(z.object({ jsonPointer: z.string(), keyword: z.string(), schemaPath: z.string(), message: z.string(), expected: z.string().optional(), observedType: z.string().optional(), missingProperty: z.string().optional(), additionalProperty: z.string().optional(), allowedValues: z.array(z.unknown()).optional() }).strict()).min(1).max(32),
  redactedPaths: z.array(z.string()).max(0),
}).strict();

export type PayloadProposalResult =
  | { status: "unavailable" | "needs_human_input"; code: string }
  | { status: "ready"; code: "PINNED_BODY_CHECK_PASSED"; incidentId: string; candidateText: string; sourceBodySha256: string; pinnedSpecId: string; pinnedSpecSha256: string; candidateSha256: string; jsonPointer: string; provider: string; model: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Read-only proposal generation. Existing human test and acceptance actions remain separate. */
export async function generatePayloadProposal(db: PrismaClient, workspaceId: string, incidentId: string, adapter: ProposalAdapter): Promise<PayloadProposalResult> {
  const refuse = (code: string): PayloadProposalResult => ({ status: "needs_human_input", code });
  const load = () => db.incident.findFirst({ where: { id: incidentId, workspaceId }, include: { apiSpec: true } });
  const incident = await load();
  if (!incident || incident.workspaceId !== workspaceId) return { status: "unavailable", code: "INCIDENT_NOT_FOUND" };
  if (incident.status === "APPROVED" || incident.validationStatus !== "MISMATCH") return refuse("NO_ELIGIBLE_MISMATCH");
  const spec = incident.apiSpec;
  if (!spec || spec.id !== incident.apiSpecId || spec.workspaceId !== workspaceId || spec.apiKey !== incident.apiKey || spec.environment !== incident.environment) return refuse("PINNED_SPEC_SCOPE_MISMATCH");
  const parsed = storedEvidenceSchema.safeParse(incident.validationEvidence);
  if (!parsed.success || parsed.data.specRevision.apiSpecId !== spec.id || parsed.data.specRevision.sourceSha256 !== spec.sourceSha256) return refuse("INCOMPLETE_OR_STALE_EVIDENCE");
  const original = safeProposalBody(incident.sanitizedRequestBody);
  if (!original) return refuse("BODY_PROTECTION_BLOCKED");
  const resolved = resolveOpenApiJsonRequestBodySchema({ parsedDocument: spec.parsedDocument, openApiVersion: spec.openApiVersion, apiSpecId: spec.id, sourceSha256: spec.sourceSha256, httpMethod: incident.httpMethod, requestPath: incident.requestPath });
  if (resolved.status !== "resolved") return refuse("UNSUPPORTED_SCHEMA");
  const current = validateJsonSchemaPayload(resolved.requestBodySchema, incident.sanitizedRequestBody);
  if (current.status !== "mismatch") return refuse("NO_CURRENT_MISMATCH");
  const identity = (items: Array<{ jsonPointer: string; keyword: string; schemaPath: string; expected?: string; observedType?: string }>) => JSON.stringify(items.map(({ jsonPointer, keyword, schemaPath, expected, observedType }) => ({ jsonPointer, keyword, schemaPath, expected, observedType })));
  if (identity(current.evidence) !== identity(parsed.data.findings)) return refuse("INCOMPLETE_OR_STALE_EVIDENCE");
  let bundle;
  try { bundle = await buildAgentEvidenceBundle(db, workspaceId, incidentId); } catch { return refuse("EVIDENCE_EXPORT_BLOCKED"); }
  if (!bundle.protection.evidenceComplete || bundle.protection.redactedPathCount || bundle.protection.redactionBlockedValidation || bundle.protection.outputTruncated || bundle.protection.omissions.length || bundle.http.operationPathOmissionCode) return refuse("EVIDENCE_EXPORT_BLOCKED");
  const findings = bundle.findings.flatMap((finding, findingIndex) => finding.ruleKeyword === "type" && finding.observedJsonType === "string" && finding.constraints.some((item) => item.kind === "expected_json_type" && item.expectedJsonType === "integer") && current.evidence.some((item) => item.jsonPointer === finding.jsonPointer && item.keyword === "type" && item.expected === "integer" && item.observedType === "string") && createIntegerCandidate(incident.sanitizedRequestBody, finding.jsonPointer)
    ? [{ findingIndex, jsonPointer: finding.jsonPointer, rule: "type" as const, observedType: "string" as const, expectedType: "integer" as const }] : []);
  const input = proposalInputSchema.safeParse({ version: 1, findings });
  if (!input.success) return refuse("NO_LOSSLESS_TRANSFORMATION");
  const sourceFingerprint = hash(JSON.stringify(incident));
  let raw: unknown;
  try { raw = await adapter.propose(input.data); } catch { return { status: "unavailable", code: "PROPOSAL_PROVIDER_FAILED" }; }
  const plan = proposalPlanSchema.safeParse(raw);
  if (!plan.success) return refuse("PROPOSAL_PLAN_REJECTED");
  if (plan.data.decision === "abstain") return refuse(plan.data.reasonCode);
  const operation = plan.data;
  const selected = input.data.findings.find((finding) => finding.findingIndex === operation.findingIndex && finding.jsonPointer === operation.jsonPointer);
  if (!selected) return refuse("PROPOSAL_PLAN_REJECTED");
  const candidate = createIntegerCandidate(incident.sanitizedRequestBody, selected.jsonPointer);
  if (!candidate) return refuse("NO_LOSSLESS_TRANSFORMATION");
  const checked = await evaluateCandidate(db, workspaceId, { incidentId, candidateText: candidate.candidateText, revision: "pinned" });
  if (!checked.ok || !checked.eligible || checked.specId !== spec.id) return refuse("CANDIDATE_BODY_CHECK_FAILED");
  const latest = await load();
  if (!latest || hash(JSON.stringify(latest)) !== sourceFingerprint) return refuse("SOURCE_CHANGED_DURING_PROPOSAL");
  return { status: "ready", code: "PINNED_BODY_CHECK_PASSED", incidentId, candidateText: candidate.candidateText, sourceBodySha256: hash(original), pinnedSpecId: spec.id, pinnedSpecSha256: spec.sourceSha256, candidateSha256: hash(candidate.candidateText), jsonPointer: selected.jsonPointer, provider: adapter.provider, model: adapter.model };
}
