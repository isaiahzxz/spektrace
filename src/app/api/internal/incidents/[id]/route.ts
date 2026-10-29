import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { getPrisma } from "@/lib/db";
import { serializeIncident } from "@/server/serializers/incident-public";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { id } = await context.params;
  const prisma = getPrisma();
  const incident = await prisma.incident.findFirst({
    where: { id, workspaceId: auth.workspaceId },
  });

  if (!incident) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(serializeIncident(incident));
}
