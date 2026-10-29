import { getPrisma } from "@/lib/db";
import { handleOnboardingGet,handleOnboardingPost } from "@/server/notifications/onboarding-http";
export async function GET(request:Request){return handleOnboardingGet(request,getPrisma());}
export async function POST(request:Request){return handleOnboardingPost(request,getPrisma());}
