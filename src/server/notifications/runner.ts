import type { PrismaClient } from "@/generated/prisma/client";
import { collectNotifications } from "./service";
import { deliverNotifications } from "./delivery";
export async function runNotificationCycle(db:PrismaClient){
 const rows=await db.$queryRaw<{workspace_id:string}[]>`SELECT workspace_id FROM notification_preferences WHERE (preferences->>'enabled')::boolean=true`;
 for(const row of rows)await collectNotifications(db,row.workspace_id);
 return deliverNotifications(db);
}
