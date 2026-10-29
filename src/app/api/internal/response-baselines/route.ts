import { getPrisma } from "@/lib/db";
import { handleResponseBaseline } from "@/server/integration-observations/http";
export async function POST(request: Request) {
  return handleResponseBaseline(request, getPrisma());
}
