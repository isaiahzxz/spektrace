import { z } from "zod";
import { ActorType, AuditEventType, type Prisma, type PrismaClient } from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import { generateIngestionToken, ingestionTokenHash, ingestionTokenMatches, parseIngestionToken } from "@/lib/ingestion/credential-token";

const uuid = z.string().uuid();
const nameSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/);
type Tx = Prisma.TransactionClient;
export class IngestionUnauthorizedError extends Error {
  constructor() { super("Unauthorized"); }
}

export async function authenticateIngestionToken(db: PrismaClient | Tx, token: string) {
  const parsed = parseIngestionToken(token);
  if (!parsed) throw new IngestionUnauthorizedError();
  const row = await db.ingestionCredential.findUnique({ where: { id: parsed.id } });
  const matches = ingestionTokenMatches(token, row?.tokenSha256 ?? "0".repeat(64));
  if (!row || !matches || row.revokedAt || row.expiresAt <= new Date()) throw new IngestionUnauthorizedError();
  return { workspaceId: row.workspaceId, credentialId: row.id };
}

export async function lockIngestionToken(tx: Tx, token: string) {
  const parsed = parseIngestionToken(token);
  if (!parsed) throw new IngestionUnauthorizedError();
  // The shared lock covers duplicate receipts as well as writes. Revocation takes an exclusive lock.
  await tx.$queryRaw`SELECT id FROM ingestion_credentials WHERE id = ${parsed.id}::uuid FOR SHARE`;
  return authenticateIngestionToken(tx, token);
}

async function createCredential(tx: Tx, workspaceId: string, name: string, material: ReturnType<typeof generateIngestionToken>) {
  const parsed = parseIngestionToken(material.token);
  if (!parsed || parsed.id !== material.id) throw new Error("Invalid credential material");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 90 * 86400_000);
  return tx.ingestionCredential.create({ data: {
    id: material.id, workspaceId, name, tokenSha256: ingestionTokenHash(material.token), createdAt, expiresAt,
  }, select: { id: true, workspaceId: true, name: true, createdAt: true, expiresAt: true, revokedAt: true } });
}

export async function issueIngestionCredential(db: PrismaClient, workspaceId: string, name: string,
  deliver?: (material: ReturnType<typeof generateIngestionToken>) => Promise<void>) {
  uuid.parse(workspaceId);
  const safeName = nameSchema.parse(name);
  const material = generateIngestionToken();
  // Deliver before activation: delivery failure cannot leave an active, inaccessible credential.
  await deliver?.(material);
  const credential = await db.$transaction(async (tx) => {
    const created = await createCredential(tx, workspaceId, safeName, material);
    await appendAuditLog(tx, { workspaceId, eventType: AuditEventType.INGESTION_CREDENTIAL_ISSUED,
      actorType: ActorType.SYSTEM, metadata: { credentialId: created.id } });
    return created;
  });
  return { credential, token: material.token };
}

export async function revokeIngestionCredential(db: PrismaClient, workspaceId: string, id: string) {
  uuid.parse(workspaceId); uuid.parse(id);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ingestion_credentials WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid FOR UPDATE`;
    const row = await tx.ingestionCredential.findFirst({ where: { id, workspaceId } });
    if (!row) throw new Error("Credential unavailable");
    if (row.revokedAt) return { id, revoked: true };
    await tx.ingestionCredential.update({ where: { id }, data: { revokedAt: new Date() } });
    await appendAuditLog(tx, { workspaceId, eventType: AuditEventType.INGESTION_CREDENTIAL_REVOKED,
      actorType: ActorType.SYSTEM, metadata: { credentialId: id } });
    return { id, revoked: true };
  });
}

export async function rotateIngestionCredential(db: PrismaClient, workspaceId: string, id: string,
  deliver?: (material: ReturnType<typeof generateIngestionToken>) => Promise<void>) {
  uuid.parse(workspaceId); uuid.parse(id);
  const material = generateIngestionToken();
  await deliver?.(material);
  const credential = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ingestion_credentials WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid FOR UPDATE`;
    const row = await tx.ingestionCredential.findFirst({ where: { id, workspaceId } });
    if (!row || row.revokedAt || row.expiresAt <= new Date()) throw new Error("Credential unavailable");
    const created = await createCredential(tx, workspaceId, row.name, material);
    await tx.ingestionCredential.update({ where: { id }, data: { revokedAt: new Date() } });
    await appendAuditLog(tx, { workspaceId, eventType: AuditEventType.INGESTION_CREDENTIAL_ROTATED,
      actorType: ActorType.SYSTEM, metadata: { credentialId: id, replacementCredentialId: created.id } });
    return created;
  });
  return { credential, token: material.token };
}
