import { NextResponse } from "next/server";
import { parseIngestionAuthorization } from "@/lib/ingestion/credential-token";
import { authenticateIngestionToken, IngestionUnauthorizedError } from "@/server/services/ingestion-credentials";
import { getPrisma } from "@/lib/db";
import { incidentSubmissionSchema } from "@/lib/validation/incident-envelope";
import {
  IncidentSubmissionConflictError,
  submitIncidentWithIngestionToken,
} from "@/server/services/incident-submission";

export async function POST(request: Request) {
  const auth = parseIngestionAuthorization(request.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const prisma = getPrisma();
  try {
    await authenticateIngestionToken(prisma, auth.token);
  } catch (error) {
    return NextResponse.json({ error: error instanceof IngestionUnauthorizedError ? "Unauthorized" : "Service unavailable" },
      { status: error instanceof IngestionUnauthorizedError ? 401 : 503 });
  }

  let json: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65_536) {
          await reader.cancel();
          return NextResponse.json({ error: "Submission too large" }, { status: 413 });
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = incidentSubmissionSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid incident submission", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await submitIncidentWithIngestionToken(prisma, auth.token, parsed.data);
    const body = { id: result.incident.id, created: result.created, receivedAt: result.incident.receivedAt.toISOString() };
    if (result.created) {
      return NextResponse.json(body, { status: 202 });
    }
    return NextResponse.json(body, { status: 200 });
  } catch (error) {
    if (error instanceof IngestionUnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof IncidentSubmissionConflictError) {
      return NextResponse.json({ error: "Incident submission conflict" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to store incident" }, { status: 500 });
  }
}
