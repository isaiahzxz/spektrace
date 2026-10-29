import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { senderGroupingIdentity, groupingRevisionIdentity } from "@/lib/investigation/sender-grouping";
import { buildUnsupportedEvidenceV1 } from "@/lib/validation/validation-evidence-v1";

function senderFixture() {
  const id = randomUUID(); const workspaceId = randomUUID(); const senderId = randomUUID(); const bindingId = randomUUID(); const credentialId = randomUUID();
  const principalRef = randomUUID(); const registeredAt = new Date("2025-01-01T00:00:00.000Z");
  return { id, workspaceId, apiKey: "payments", environment: "default", senderId, senderBindingId: bindingId, collectorCredentialId: credentialId,
    senderClaim: { principalKind: "api_key_id" as const, principalRef }, senderProvenance: {
      version: "sender-identity@1", assurance: "integration_attested", reason: "INTEGRATION_ATTESTED", selectedAt: "2025-01-01T00:00:01.000Z",
      originalAuthenticationVerifiedBySpekTrace: false, collectorCredentialId: credentialId, senderId, bindingId,
      bindingRegisteredAt: registeredAt.toISOString(), principalKind: "api_key_id", authority: "configured_integration",
    }, senderBinding: { id: bindingId, workspaceId, ingestionCredentialId: credentialId, apiKey: "payments", environment: "default",
      principalKind: "api_key_id", principalRef, senderId, createdAt: registeredAt, sender: { id: senderId, workspaceId } } };
}
describe("grouping snapshot boundaries", () => {
  it("derives trusted keys from canonical ids and isolates all unknown incidents", () => {
    const input = senderFixture();
    expect(senderGroupingIdentity(input)).toEqual({ senderId: input.senderId, senderGroupingKey: `sender:${input.senderId}` });
    const first = senderGroupingIdentity({ ...input, senderProvenance: null });
    const second = senderGroupingIdentity({ ...input, id: randomUUID(), senderProvenance: { assurance: "reported" } });
    expect(first.senderId).toBeNull(); expect(second.senderId).toBeNull(); expect(first.senderGroupingKey).not.toBe(second.senderGroupingKey);
  });
  it("refuses transplanted or inconsistent provenance, claims, registry and scope", () => {
    const input = senderFixture();
    for (const patch of [{ senderId: randomUUID() }, { collectorCredentialId: randomUUID() }, { environment: "staging" },
      { senderClaim: { ...input.senderClaim, principalKind: "client_id" } }, { senderBindingId: randomUUID() },
      { senderProvenance: { ...input.senderProvenance, originalAuthenticationVerifiedBySpekTrace: true } },
      { senderBinding: { ...input.senderBinding, sender: { id: input.senderId, workspaceId: randomUUID() } } }])
      expect(senderGroupingIdentity({ ...input, ...patch }).senderId).toBeNull();
  });
  it("requires matching scoped spec id and hash in stored evidence and isolates uncertain revisions", () => {
    const id = randomUUID(); const workspaceId = randomUUID(); const apiSpecId = randomUUID(); const hash = "a".repeat(64);
    const input = { id, workspaceId, apiKey: "payments", environment: "default", apiSpecId, httpMethod: "POST", validationStatus: "UNSUPPORTED" as const,
      validationEvidence: buildUnsupportedEvidenceV1({ apiSpecId, sourceSha256: hash, reasonCode: "REQUEST_BODY_MISSING", reasonMessage: "Synthetic" }),
      apiSpec: { id: apiSpecId, workspaceId, apiKey: "payments", environment: "default", sourceSha256: hash } };
    expect(groupingRevisionIdentity(input)).toEqual({ apiSpecId, pinnedApiSpecKey: apiSpecId });
    for (const patch of [{ apiSpecId: null }, { apiSpec: { ...input.apiSpec, sourceSha256: "b".repeat(64) } },
      { apiSpec: { ...input.apiSpec, environment: "other" } }, { validationEvidence: null },
      { validationEvidence: { version: 1, specRevision: { apiSpecId, sourceSha256: hash } } }])
      expect(groupingRevisionIdentity({ ...input, ...patch })).toEqual({ apiSpecId: null, pinnedApiSpecKey: `unknown_revision:${id}` });
  });
});
