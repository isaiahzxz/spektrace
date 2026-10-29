import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { getPrisma } from "@/lib/db";
import { requestInferenceWithRepositorySnapshot } from "@/server/repository-context/request-inference-with-snapshot";

const bodySchema = z
  .object({
    repositoryContextSnapshotId: z.string().uuid(),
    evidencePreparationRunId: z.string().uuid().optional(),
  })
  .strict();

type RouteContext = { params: Promise<{ groupId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof NextResponse) return auth;

  const { groupId } = await context.params;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }

  const result = await requestInferenceWithRepositorySnapshot(getPrisma(), {
    workspaceId: auth.workspaceId,
    investigationGroupId: groupId,
    repositoryContextSnapshotId: parsed.data.repositoryContextSnapshotId,
    evidencePreparationRunId: parsed.data.evidencePreparationRunId,
  });

  if (!result.ok) {
    const status =
      result.code === "GROUP_NOT_FOUND" || result.code === "SNAPSHOT_NOT_FOUND" ? 404 : 400;
    return NextResponse.json({ error: result.message, code: result.code }, { status });
  }

  return NextResponse.json(
    {
      inferenceRunId: result.inferenceRunId,
      runStatus: result.runStatus,
      repositoryContextSnapshotId: parsed.data.repositoryContextSnapshotId,
    },
    { status: 200 },
  );
}
