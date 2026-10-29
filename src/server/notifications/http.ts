import type { PrismaClient } from "@/generated/prisma/client";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { integrationStatus } from "./status";
export async function handleIntegrationStatus(request: Request, db: PrismaClient) {
    const auth = authorizeInternalRequest(request.headers.get('authorization'));
    if (auth instanceof Response)
        return auth;
    try {
        return Response.json(await integrationStatus(db, auth.workspaceId), { headers: { 'cache-control': 'no-store' } });
    }
    catch {
        return Response.json({ error: 'Status unavailable' }, { status: 503 });
    }
}
