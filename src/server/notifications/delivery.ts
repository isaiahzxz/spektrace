import { canonical } from "@/lib/integration-observations/contract";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { deliveryTargets,type AlertCategory } from "@/lib/notifications/policy";
import { workspaceEmailRecipients } from "./recipients";
import { readPreferences } from "./service";
const destinationsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), z.object({ kind: z.enum(['slack', 'webhook','email']),workspaceId:z.string().uuid().optional(), url: z.string().url().optional(),to:z.array(z.string().email()).min(1).max(5).optional(), signingSecret: z.string().min(32).optional() }).strict());
export function destinations() {
    const parsed = destinationsSchema.parse(JSON.parse(process.env.SPEKTRACE_NOTIFICATION_DESTINATIONS ?? '{}'));
    for (const d of Object.values(parsed)) {
        if(d.kind==='email')continue;
        const u = new URL(d.url??'');
        if (u.protocol !== 'https:' || u.username || u.password || u.hash)
            throw Error('Invalid notification destination configuration');
        if (d.kind === 'slack' && (u.hostname !== 'hooks.slack.com' || !u.pathname.startsWith('/services/')))
            throw Error('Invalid Slack destination');
        if (d.kind === 'webhook' && !d.signingSecret)
            throw Error('Webhook signing secret required');
    }
    return parsed;
}
export function destinationsForWorkspace(workspaceId:string){return Object.fromEntries(Object.entries(destinations()).filter(([,d])=>process.env.SPEKTRACE_ACCOUNTS_ENABLED!=='true'||d.kind==='email'||d.workspaceId===workspaceId));}
export async function deliverNotifications(db: PrismaClient, now = new Date(), transport: typeof fetch = fetch) {
    destinations();
    // Reclaim an interrupted delivery using its original ID, so receivers can deduplicate retries.
    await db.$executeRaw `UPDATE notification_deliveries SET state=CASE WHEN attempts>=5 THEN 'FAILED' ELSE 'PENDING' END WHERE state='SENDING' AND available_at<${now}`;
    const rows = await db.$queryRaw<{
        id: string;
        workspace_id: string;
        destination: string;
        payload: {
            kind: string;
            text: string;title?:string;category?:AlertCategory;categories?:unknown;
        };
        attempts: number;
    }[]> `UPDATE notification_deliveries SET state='SENDING',attempts=attempts+1,available_at=${new Date(now.getTime() + 60000)} WHERE id IN (SELECT id FROM notification_deliveries WHERE state='PENDING' AND available_at<=${now} ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10) RETURNING *`;
    let sent = 0;
    for (const row of rows) {
        const pref = await readPreferences(db, row.workspace_id);
        if (!pref.preferences.enabled || !deliveryTargets(pref.preferences).includes(row.destination) || (row.payload.kind === 'alert' && (!pref.preferences.alerts||(row.payload.category!==undefined&&!pref.preferences.categories[row.payload.category]))) || (row.payload.kind === 'digest' && (pref.preferences.digest === 'off'||canonical(row.payload.categories)!==canonical(pref.preferences.categories)))) {
            await db.$executeRaw `UPDATE notification_deliveries SET state='CANCELLED' WHERE id=${row.id}::uuid`;
            continue;
        }
        const destination = destinationsForWorkspace(row.workspace_id)[row.destination];
        let ok = false;
        if (destination?.kind==='email') {
            const to=await workspaceEmailRecipients(db,row.workspace_id,destination.to),key=process.env.SPEKTRACE_EMAIL_API_KEY,from=process.env.SPEKTRACE_EMAIL_FROM;
            if(to.length&&key&&from){try{const r=await transport('https://api.resend.com/emails',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json','Idempotency-Key':row.id},body:JSON.stringify({from,to,subject:row.payload.kind==='test'?'SpekTrace test notification':'SpekTrace: '+(row.payload.title??'Integration digest'),text:row.payload.text}),redirect:'error',signal:AbortSignal.timeout(5000)});ok=r.ok;await r.body?.cancel();}catch{}}
        }else if (destination) {
            const body = JSON.stringify(destination.kind === 'slack' ? { text: row.payload.text, mrkdwn: false, unfurl_links: false, unfurl_media: false } : row.payload);
            const timestamp = Math.floor(now.getTime() / 1000).toString();
            try {
                const response = await transport(destination.url!, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spektrace-delivery-id': row.id, 'x-spektrace-timestamp': timestamp, ...(destination.kind === 'webhook' ? { 'x-spektrace-signature': 'sha256=' + createHmac('sha256', destination.signingSecret!).update(timestamp + '.' + body).digest('hex') } : {}) }, body, redirect: 'manual', signal: AbortSignal.timeout(5000) });
                ok = response.ok;
                await response.body?.cancel();
            }
            catch { /* Transport errors may contain destination secrets; store no raw exception. */ }
        }
        if (ok) {
            await db.$executeRaw `UPDATE notification_deliveries SET state='SENT',sent_at=${now} WHERE id=${row.id}::uuid`;
            sent++;
        }
        else {
            await db.$executeRaw `UPDATE notification_deliveries SET state=${row.attempts >= 5 ? 'FAILED' : 'PENDING'},available_at=${new Date(now.getTime() + Math.min(3600000, 30000 * 2 ** row.attempts))} WHERE id=${row.id}::uuid`;
        }
    }
    return { claimed: rows.length, sent };
}
export async function deliveryHistory(db: PrismaClient, ws: string) {
    return db.$queryRaw<{
        id: string;
        destination:string;kind:string;
        state: string;
        attempts: number;
        created_at: Date;
        sent_at: Date | null;
    }[]> `SELECT id,destination,payload->>'kind' AS kind,state,attempts,created_at,sent_at FROM notification_deliveries WHERE workspace_id=${ws}::uuid ORDER BY created_at DESC LIMIT 10`;
}
