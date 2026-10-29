import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { getPrisma } from "@/lib/db";
import {
  DocumentationImportError,
  documentationContextImportSchema,
  importDocumentationContextSnapshot,
} from "@/server/documentation-context/import-snapshot";

export async function POST(request: Request) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof NextResponse) return auth;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = documentationContextImportSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid documentation import", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await importDocumentationContextSnapshot(getPrisma(), auth.workspaceId, parsed.data);
    return NextResponse.json(
      {
        id: result.snapshot.id,
        sourceKey: result.snapshot.sourceKey,
        apiKey: result.snapshot.apiKey,
        environment: result.snapshot.environment,
        importStatus: result.snapshot.importStatus,
        created: result.created,
        rejectedDocuments: result.rejected,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof DocumentationImportError) {
      const status = error.code === "NOT_ALLOWLISTED" ? 403 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "Failed to import documentation context" }, { status: 500 });
  }
}
