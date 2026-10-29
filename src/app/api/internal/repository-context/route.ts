import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { getPrisma } from "@/lib/db";
import {
  RepositoryImportError,
  importRepositoryContextSnapshot,
  repositoryContextImportSchema,
} from "@/server/repository-context/import-snapshot";

export async function POST(request: Request) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof NextResponse) return auth;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = repositoryContextImportSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid repository context import", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await importRepositoryContextSnapshot(getPrisma(), auth.workspaceId, parsed.data);
    return NextResponse.json(
      {
        id: result.snapshot.id,
        repository: result.snapshot.repository,
        commitSha: result.snapshot.commitSha,
        apiKey: result.snapshot.apiKey,
        environment: result.snapshot.environment,
        importStatus: result.snapshot.importStatus,
        created: result.created,
        rejectedFiles: result.rejected,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof RepositoryImportError) {
      const status = error.code === "NOT_ALLOWLISTED" ? 403 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "Failed to import repository context" }, { status: 500 });
  }
}
