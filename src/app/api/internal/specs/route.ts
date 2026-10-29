import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { OpenApiImportError } from "@/lib/openapi/document";
import { getPrisma } from "@/lib/db";
import { importSpecRevision, specImportSchema } from "@/server/specs/import-revision";

export async function POST(request: Request) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof NextResponse) return auth;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = specImportSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid specification import", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await importSpecRevision(getPrisma(), auth.workspaceId, parsed.data);
    return NextResponse.json(
      {
        id: result.spec.id,
        apiKey: result.spec.apiKey,
        environment: result.spec.environment,
        version: result.spec.version,
        active: result.spec.isActive,
        created: result.created,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof OpenApiImportError || (error instanceof Error && error.message.includes("already exists"))) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to import specification" }, { status: 500 });
  }
}
