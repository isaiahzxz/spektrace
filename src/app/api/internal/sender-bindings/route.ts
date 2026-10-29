import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { getPrisma } from "@/lib/db";
import { senderBindingImportSchema } from "@/lib/ingestion/sender-identity";
import { importSenderBinding, SenderBindingError } from "@/server/services/sender-identity";

export async function POST(request: Request) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof NextResponse) return auth;
  let json: unknown;
  try {
    const reader = request.body?.getReader(); if (!reader) throw new Error("Missing body");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); return NextResponse.json({ error: "Import too large" }, { status: 413 }); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = senderBindingImportSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "Invalid sender binding" }, { status: 400 });
  try {
    const result = await importSenderBinding(getPrisma(), auth.workspaceId, parsed.data);
    return NextResponse.json({ id: result.binding.id, senderId: result.binding.senderId, created: result.created,
      revoked: result.binding.revokedAt !== null, originalAuthenticationVerifiedBySpekTrace: false }, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof SenderBindingError) return NextResponse.json({ error: error.code },
      { status: error.code === "BINDING_CONFLICT" ? 409 : 400 });
    return NextResponse.json({ error: "Sender binding import failed" }, { status: 500 });
  }
}
