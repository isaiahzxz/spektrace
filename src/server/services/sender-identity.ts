import { ActorType, AuditEventType, type Prisma, type PrismaClient } from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import { senderBindingImportSchema, senderReferenceSchema, senderUuid, type SenderBindingImport, type SenderReference } from "@/lib/ingestion/sender-identity";

export class SenderBindingError extends Error {
  constructor(public readonly code: "CREDENTIAL_UNAVAILABLE" | "BINDING_UNAVAILABLE" | "BINDING_CONFLICT") {
    super(code); this.name = "SenderBindingError";
  }
}
type Tx = Prisma.TransactionClient;
type Scope = { workspaceId: string; ingestionCredentialId: string; apiKey: string; environment: string; principalKind: string; principalRef: string };

export async function lockSenderScope(tx: Tx, scope: Scope) {
  const key = JSON.stringify(["sender-binding", scope.workspaceId, scope.ingestionCredentialId, scope.apiKey,
    scope.environment, scope.principalKind, scope.principalRef]);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}
async function lockCredential(tx: Tx, workspaceId: string, id: string, requireActive: boolean) {
  await tx.$queryRaw`SELECT id FROM ingestion_credentials WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid FOR SHARE`;
  const credential = await tx.ingestionCredential.findFirst({ where: { id, workspaceId } });
  if (!credential || (requireActive && (credential.revokedAt || credential.expiresAt <= new Date())))
    throw new SenderBindingError("CREDENTIAL_UNAVAILABLE");
}

export async function importSenderBinding(db: PrismaClient, workspaceId: string, raw: SenderBindingImport) {
  const input = senderBindingImportSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await lockCredential(tx, workspaceId, input.ingestionCredentialId, true);
    const scope = { workspaceId, ingestionCredentialId: input.ingestionCredentialId, apiKey: input.apiKey,
      environment: input.environment, principalKind: input.principalKind, principalRef: input.principalRef };
    await lockSenderScope(tx, scope);
    const existing = await tx.senderBinding.findFirst({ where: scope, include: { sender: true } });
    if (existing) {
      if (existing.sender.senderKey !== input.senderKey || existing.sender.displayName !== input.displayName)
        throw new SenderBindingError("BINDING_CONFLICT");
      return { binding: existing, created: false };
    }
    const registryKey = JSON.stringify(["sender-registry", workspaceId, input.senderKey]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${registryKey}, 0))::text`;
    let sender = await tx.workspaceSender.findUnique({ where: { workspaceId_senderKey: { workspaceId, senderKey: input.senderKey } } });
    if (sender && sender.displayName !== input.displayName) throw new SenderBindingError("BINDING_CONFLICT");
    sender ??= await tx.workspaceSender.create({ data: { workspaceId, senderKey: input.senderKey, displayName: input.displayName } });
    const binding = await tx.senderBinding.create({ data: { ...scope, senderId: sender.id } });
    await appendAuditLog(tx, { workspaceId, eventType: AuditEventType.SENDER_BINDING_REGISTERED, actorType: ActorType.SYSTEM,
      metadata: { bindingId: binding.id, senderId: sender.id, credentialId: input.ingestionCredentialId } });
    return { binding, created: true };
  });
}

export async function revokeSenderBinding(db: PrismaClient, workspaceId: string, rawId: string) {
  const id = senderUuid.parse(rawId);
  return db.$transaction(async (tx) => {
    const binding = await tx.senderBinding.findFirst({ where: { id, workspaceId } });
    if (!binding) throw new SenderBindingError("BINDING_UNAVAILABLE");
    await lockCredential(tx, workspaceId, binding.ingestionCredentialId, false);
    await lockSenderScope(tx, binding);
    await tx.$queryRaw`SELECT id FROM sender_bindings WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid FOR UPDATE`;
    const current = await tx.senderBinding.findFirstOrThrow({ where: { id, workspaceId } });
    if (current.revokedAt) return { id, revoked: true };
    await tx.senderBinding.update({ where: { id }, data: { revokedAt: new Date() } });
    await appendAuditLog(tx, { workspaceId, eventType: AuditEventType.SENDER_BINDING_REVOKED, actorType: ActorType.SYSTEM, metadata: { bindingId: id } });
    return { id, revoked: true };
  });
}

export async function resolveIncidentSender(tx: Tx, workspaceId: string, credentialId: string | null,
  apiKey: string, environment: string, rawClaim?: SenderReference, reportedClientRef?: string) {
  const claim = rawClaim ? senderReferenceSchema.parse(rawClaim) : null;
  let reason = claim ? "COLLECTOR_NOT_AUTHENTICATED" : reportedClientRef ? "REPORTED_HEADER_ONLY" : "SENDER_NOT_SUPPLIED";
  let binding: Awaited<ReturnType<typeof tx.senderBinding.findFirst>> = null;
  if (claim && credentialId) {
    const scope = { workspaceId, ingestionCredentialId: credentialId, apiKey, environment, ...claim };
    await lockSenderScope(tx, scope);
    await tx.$queryRaw`SELECT id FROM sender_bindings WHERE workspace_id = ${workspaceId}::uuid
      AND ingestion_credential_id = ${credentialId}::uuid AND api_key = ${apiKey} AND environment = ${environment}
      AND principal_ref = ${claim.principalRef}::uuid AND principal_kind = ${claim.principalKind} FOR SHARE`;
    binding = await tx.senderBinding.findFirst({ where: scope });
    reason = !binding ? "SENDER_UNMAPPED" : binding.revokedAt ? "SENDER_BINDING_REVOKED" : "INTEGRATION_ATTESTED";
  }
  const selected = reason === "INTEGRATION_ATTESTED" ? binding : null;
  const provenance: Prisma.InputJsonObject = {
    version: "sender-identity@1", assurance: selected ? "integration_attested" : reportedClientRef ? "reported" : "unknown",
    reason, selectedAt: new Date().toISOString(), originalAuthenticationVerifiedBySpekTrace: false,
    ...(credentialId ? { collectorCredentialId: credentialId } : {}),
    ...(selected ? { senderId: selected.senderId, bindingId: selected.id, bindingRegisteredAt: selected.createdAt.toISOString(),
      principalKind: selected.principalKind, authority: "configured_integration" } : {}),
  };
  return { senderId: selected?.senderId ?? null, senderBindingId: selected?.id ?? null, provenance };
}
