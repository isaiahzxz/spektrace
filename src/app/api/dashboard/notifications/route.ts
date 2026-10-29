import { getPrisma } from '@/lib/db';
import { handleInboxGet } from '@/server/notifications/inbox';
export async function GET(request:Request){return handleInboxGet(request,getPrisma());}
