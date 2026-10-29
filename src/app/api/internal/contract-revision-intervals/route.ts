import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { getPrisma } from "@/lib/db";
import { historicalBindingImportSchema } from "@/lib/specs/historical-revisions";
import { HistoricalBindingError, importHistoricalBinding } from "@/server/services/historical-revisions";

export async function POST(request: Request) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof NextResponse) return auth;
  let json: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing body");
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
  const parsed = historicalBindingImportSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "Invalid historical binding" }, { status: 400 });
  try {
    const result = await importHistoricalBinding(getPrisma(), auth.workspaceId, parsed.data);
    return NextResponse.json({ id: result.binding.id, created: result.created,
      authority: "operator_asserted_interval", runtimeVerified: false }, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof HistoricalBindingError) return NextResponse.json({ error: error.code },
      { status: error.code === "NOT_ALLOWLISTED" ? 403 : error.code === "IMPORT_CONFLICT" ? 409 : 400 });
    return NextResponse.json({ error: "Historical binding import failed" }, { status: 500 });
  }
}
