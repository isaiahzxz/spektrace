import { getPrisma } from "@/lib/db";
import { handleIntegrationIngestion } from "@/server/integration-observations/http";
export async function POST(request: Request) {
  return handleIntegrationIngestion(request, getPrisma(), "outcome");
}
