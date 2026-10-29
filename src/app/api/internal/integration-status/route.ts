import { getPrisma } from "@/lib/db";
import { handleIntegrationStatus } from "@/server/notifications/http";
export async function GET(request: Request) { return handleIntegrationStatus(request, getPrisma()); }
