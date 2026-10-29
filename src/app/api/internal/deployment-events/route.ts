import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { getPrisma } from "@/lib/db";
import {
  DeploymentImportError,
  deploymentEventImportSchema,
  recordDeploymentEvent,
} from "@/server/deployment-context/record-event";

export async function POST(request: Request) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof NextResponse) return auth;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = deploymentEventImportSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid deployment event", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await recordDeploymentEvent(getPrisma(), auth.workspaceId, parsed.data);
    if (!result.record) {
      return NextResponse.json({ error: "Deployment record missing" }, { status: 500 });
    }
    return NextResponse.json(
      {
        deploymentRecordId: result.record.id,
        deploymentStatusEventId: result.event.id,
        created: result.created,
        status: result.event.status,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof DeploymentImportError) {
      const status = error.code === "NOT_ALLOWLISTED" ? 403 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "Failed to record deployment event" }, { status: 500 });
  }
}
