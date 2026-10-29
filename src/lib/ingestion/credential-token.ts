import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const TOKEN = /^st_ingest_v1\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/;

export function parseIngestionToken(token: string): { id: string; token: string } | null {
  if (token.length > 128 || /\s/.test(token)) return null;
  const match = TOKEN.exec(token);
  return match ? { id: match[1], token } : null;
}

export function parseIngestionAuthorization(header: string | null) {
  if (!header || header.length > 150 || /[\r\n]/.test(header)) return null;
  const match = /^Bearer ([^\s,]+)$/i.exec(header);
  return match ? parseIngestionToken(match[1]) : null;
}

export function ingestionTokenHash(token: string): string {
  return createHash("sha256").update("spektrace:ingestion:v1\0").update(token).digest("hex");
}

export function ingestionTokenMatches(token: string, hash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  return timingSafeEqual(Buffer.from(ingestionTokenHash(token), "hex"), Buffer.from(hash, "hex"));
}

export function generateIngestionToken() {
  const id = randomUUID();
  const token = `st_ingest_v1.${id}.${randomBytes(32).toString("base64url")}`;
  return { id, token };
}
