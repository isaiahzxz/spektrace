import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { getPrisma } from "@/lib/db";
import { requestInferenceWithContext } from "@/server/investigation/request-inference-with-context";

const bodySchema = z
  .object({
    repositoryContextSnapshotId: z.string().uuid().optional(),
    documentationContextSnapshotId: z.string().uuid().optional(),
    evidencePreparationRunId: z.string().uuid().optional(),
    includeDeploymentContext: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(
        value.repositoryContextSnapshotId ||
          value.documentationContextSnapshotId ||
          value.includeDeploymentContext,
      ),
    { message: "Select at least one context source" },
  );

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

  const result = await requestInferenceWithContext(getPrisma(), {
    workspaceId: auth.workspaceId,
    investigationGroupId: groupId,
    repositoryContextSnapshotId: parsed.data.repositoryContextSnapshotId,
    documentationContextSnapshotId: parsed.data.documentationContextSnapshotId,
    evidencePreparationRunId: parsed.data.evidencePreparationRunId,
    includeDeploymentContext: parsed.data.includeDeploymentContext,
  });

  if (!result.ok) {
    const status =
      result.code === "GROUP_NOT_FOUND" ||
      result.code === "SNAPSHOT_NOT_FOUND" ||
      result.code === "DOCUMENTATION_SNAPSHOT_NOT_FOUND"
        ? 404
        : 400;
    return NextResponse.json({ error: result.message, code: result.code }, { status });
  }

  return NextResponse.json(
    {
      inferenceRunId: result.inferenceRunId,
      runStatus: result.runStatus,
      repositoryContextSnapshotId: parsed.data.repositoryContextSnapshotId ?? null,
      documentationContextSnapshotId: parsed.data.documentationContextSnapshotId ?? null,
      includeDeploymentContext: parsed.data.includeDeploymentContext ?? false,
    },
    { status: 200 },
  );
}
