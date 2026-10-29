import { NextResponse } from "next/server";
import { ActorType } from "@/generated/prisma/client";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { getPrisma } from "@/lib/db";
import { SpecActivationError, activateApiSpecRevision } from "@/server/repositories/api-specs";
import { specActivationSchema } from "@/server/specs/import-revision";

export async function POST(request: Request) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof NextResponse) return auth;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = specActivationSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid activation request" }, { status: 400 });
  }

  try {
    const spec = await activateApiSpecRevision(getPrisma(), auth.workspaceId, parsed.data.apiSpecId, {
      actorType: ActorType.SYSTEM,
    });
    return NextResponse.json({
      id: spec.id,
      apiKey: spec.apiKey,
      environment: spec.environment,
      version: spec.version,
      active: spec.isActive,
    });
  } catch (error) {
    if (error instanceof SpecActivationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: "Revision was not found in this workspace." }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to activate specification" }, { status: 500 });
  }
}
