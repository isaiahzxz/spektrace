import { NextResponse } from "next/server";
import {
  InternalConfigError,
  requireInternalPilotConfig,
  verifyInternalApiToken,
} from "@/lib/internal-config";

export function extractBearerToken(
  authorizationHeader: string | null,
): string | null {
  if (!authorizationHeader) {
    return null;
  }
  if (authorizationHeader.length > 4096 || /[\r\n]/.test(authorizationHeader)) return null;
  const match = /^Bearer ([^\s,]+)$/i.exec(authorizationHeader);
  return match?.[1] ?? null;
}

export function authorizeInternalRequest(
  authorizationHeader: string | null,
): { workspaceId: string } | NextResponse {
  try {
    const config = requireInternalPilotConfig();
    const token = extractBearerToken(authorizationHeader);
    if (token?.startsWith("st_ingest_") || !verifyInternalApiToken(token, config.apiToken)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return { workspaceId: config.workspaceId };
  } catch (error) {
    if (error instanceof InternalConfigError) {
      return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
