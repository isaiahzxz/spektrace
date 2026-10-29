import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { getPrisma } from "@/lib/db";
import { senderUuid } from "@/lib/ingestion/sender-identity";
import { revokeSenderBinding, SenderBindingError } from "@/server/services/sender-identity";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof NextResponse) return auth;
  const parsed = senderUuid.safeParse((await context.params).id);
  if (!parsed.success) return NextResponse.json({ error: "Invalid binding" }, { status: 400 });
  try { return NextResponse.json(await revokeSenderBinding(getPrisma(), auth.workspaceId, parsed.data)); }
  catch (error) { return NextResponse.json({ error: "Binding unavailable" }, { status: error instanceof SenderBindingError ? 404 : 500 }); }
}
