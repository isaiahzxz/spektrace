import { z } from "zod";
import { senderReferenceSchema } from "@/lib/ingestion/sender-identity";
import { parseStoredValidationEvidence } from "@/lib/agent-evidence/parse-stored-evidence";
import { ValidationStatus } from "@/generated/prisma/client";

export const SENDER_GROUPING_VERSION = 2;
const attestation = z.object({
  version: z.literal("sender-identity@1"), assurance: z.literal("integration_attested"), reason: z.literal("INTEGRATION_ATTESTED"),
  selectedAt: z.string().datetime(), originalAuthenticationVerifiedBySpekTrace: z.literal(false),
  collectorCredentialId: z.string().uuid(), senderId: z.string().uuid(), bindingId: z.string().uuid(),
  bindingRegisteredAt: z.string().datetime(), principalKind: z.enum(["client_id", "api_key_id"]), authority: z.literal("configured_integration"),
}).strict();
const groupingEvidence = z.object({
  version: z.literal(1), checkedAt: z.string().datetime(), outcome: z.nativeEnum(ValidationStatus),
  scope: z.object({ label: z.string().min(1), covers: z.literal("json_request_body_only"), matchedPath: z.string().nullable(), matchedMethod: z.string().nullable() }),
  specRevision: z.object({ apiSpecId: z.string().uuid(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  validator: z.object({ engine: z.literal("ajv"), schemaDialect: z.literal("https://json-schema.org/draft/2020-12/schema") }),
  findings: z.array(z.object({
    jsonPointer: z.string(), keyword: z.string().min(1), schemaPath: z.string(), message: z.string(),
    expected: z.string().optional(), observedType: z.string().optional(), missingProperty: z.string().optional(), additionalProperty: z.string().optional(),
    allowedValues: z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).optional(),
  }).strict()),
});

interface SenderGroupingInput {
  id: string; workspaceId: string; apiKey: string; environment: string;
  senderId: string | null; senderBindingId: string | null; collectorCredentialId: string | null;
  senderClaim: unknown; senderProvenance: unknown;
  senderBinding: { id: string; workspaceId: string; ingestionCredentialId: string; apiKey: string; environment: string;
    principalKind: string; principalRef: string; senderId: string; createdAt: Date;
    sender: { id: string; workspaceId: string } } | null;
}

export function senderGroupingIdentity(input: SenderGroupingInput): { senderId: string | null; senderGroupingKey: string } {
  const unknown = { senderId: null, senderGroupingKey: `unknown:${input.id}` };
  const parsed = attestation.safeParse(input.senderProvenance); const claim = senderReferenceSchema.safeParse(input.senderClaim);
  const binding = input.senderBinding;
  if (!parsed.success || !claim.success || !binding) return unknown;
  const proof = parsed.data;
  if (!input.senderId || input.senderId !== proof.senderId || input.senderId !== binding.senderId ||
    binding.sender.id !== input.senderId || binding.sender.workspaceId !== input.workspaceId ||
    input.senderBindingId !== binding.id || proof.bindingId !== binding.id || binding.workspaceId !== input.workspaceId ||
    input.collectorCredentialId !== proof.collectorCredentialId || input.collectorCredentialId !== binding.ingestionCredentialId ||
    binding.apiKey !== input.apiKey || binding.environment !== input.environment ||
    proof.principalKind !== claim.data.principalKind || binding.principalKind !== claim.data.principalKind ||
    binding.principalRef !== claim.data.principalRef || proof.bindingRegisteredAt !== binding.createdAt.toISOString() ||
    Date.parse(proof.selectedAt) < binding.createdAt.getTime()) return unknown;
  return { senderId: input.senderId, senderGroupingKey: `sender:${input.senderId}` };
}

export function groupingRevisionIdentity(input: {
  id: string; workspaceId: string; apiKey: string; environment: string; apiSpecId: string | null; validationEvidence: unknown;
  httpMethod: string; validationStatus: ValidationStatus;
  apiSpec: { id: string; workspaceId: string; apiKey: string; environment: string; sourceSha256: string } | null;
}): { apiSpecId: string | null; pinnedApiSpecKey: string } {
  const evidence = parseStoredValidationEvidence(input.validationEvidence); const spec = input.apiSpec;
  const structural = groupingEvidence.safeParse(input.validationEvidence);
  const validEvidence = structural.success && structural.data.outcome === input.validationStatus &&
    (input.validationStatus !== ValidationStatus.MISMATCH || structural.data.findings.length > 0) &&
    (input.validationStatus !== ValidationStatus.PASSED || structural.data.findings.length === 0) &&
    (![ValidationStatus.MISMATCH, ValidationStatus.PASSED].some((status) => status === input.validationStatus) ||
      (structural.data.scope.matchedMethod === input.httpMethod.trim().toUpperCase() && Boolean(structural.data.scope.matchedPath)));
  if (!spec || input.apiSpecId !== spec.id || spec.workspaceId !== input.workspaceId || spec.apiKey !== input.apiKey ||
    spec.environment !== input.environment || !validEvidence || !/^[a-f0-9]{64}$/.test(spec.sourceSha256) || evidence.format !== "v1" ||
    evidence.specApiSpecId !== spec.id || evidence.specSourceSha256 !== spec.sourceSha256)
    return { apiSpecId: null, pinnedApiSpecKey: `unknown_revision:${input.id}` };
  return { apiSpecId: spec.id, pinnedApiSpecKey: spec.id };
}
