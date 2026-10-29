import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { defaultPreferences, preferencesSchema, digestPeriod, shouldUpdate, safeText, deliveryTargets, findingCategory,findingTitle, type NotificationPreferences } from "@/lib/notifications/policy";
import { digest } from "@/lib/integration-observations/contract";
import { integrationStatus } from "./status";
import { loadObservation } from "@/server/dashboard/integration-observations";

export function investigationUrl(id:string){const origin=new URL(process.env.SPEKTRACE_DASHBOARD_ORIGIN??process.env.BETTER_AUTH_URL??'http://127.0.0.1:3000');if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||!['http:','https:'].includes(origin.protocol))throw Error('Invalid dashboard origin');return new URL('/alerts/'+id,origin).href;}
type PrefRow = {
    preferences: unknown;
    enabled_since: Date;
    digest_cursor: Date;
};
type Summary = {
    title: string;
    integration: string;
    provider: string;
    environment: string;
    operation: string;
    finding: string;
    changes: string[];
    observationId: string;
};
export async function readPreferences(db: PrismaClient, ws: string) {
    const rows = await db.$queryRaw<PrefRow[]> `SELECT preferences,enabled_since,digest_cursor FROM notification_preferences WHERE workspace_id=${ws}::uuid`;
    return rows[0] ? { ...rows[0], preferences: preferencesSchema.parse(rows[0].preferences) } : { preferences: defaultPreferences, enabled_since: new Date(), digest_cursor: new Date() };
}
export async function savePreferences(db: PrismaClient, ws: string, raw: unknown) {
    const p = preferencesSchema.parse(raw);
    await db.$transaction(async (tx) => {
        await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${'notifications:' + ws}))::text`;
        await tx.$executeRaw `INSERT INTO notification_preferences(workspace_id,preferences) VALUES(${ws}::uuid,${JSON.stringify(p)}::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET preferences=EXCLUDED.preferences,enabled_since=CASE WHEN NOT (notification_preferences.preferences->>'enabled')::boolean AND (EXCLUDED.preferences->>'enabled')::boolean THEN now() ELSE notification_preferences.enabled_since END,digest_cursor=CASE WHEN notification_preferences.preferences->>'digest' IS DISTINCT FROM EXCLUDED.preferences->>'digest' OR NOT (notification_preferences.preferences->>'enabled')::boolean THEN now() ELSE notification_preferences.digest_cursor END,updated_at=now()`;
        await tx.$executeRaw `UPDATE notification_deliveries SET state='CANCELLED' WHERE workspace_id=${ws}::uuid AND state='PENDING' AND (NOT ${p.enabled} OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(deliveryTargets(p))}::jsonb) t(value) WHERE t.value=notification_deliveries.destination) OR (payload->>'kind'='alert' AND NOT ${p.alerts}) OR (payload->>'kind'='digest' AND (${p.digest}='off' OR payload->'categories' IS DISTINCT FROM ${JSON.stringify(p.categories)}::jsonb)))`;
    });
    return p;
}
async function enqueue(tx:Prisma.TransactionClient,ws:string,p:NotificationPreferences,key:string,raw:unknown){for(const target of deliveryTargets(p)){const id=randomUUID();const payload:Record<string,unknown>={...raw as Record<string,unknown>,alertId:id};if(typeof payload.text==='string')payload.text+='\n'+investigationUrl(id);await tx.$executeRaw`INSERT INTO notification_deliveries(id,workspace_id,dedupe_key,destination,payload) VALUES(${id}::uuid,${ws}::uuid,${key+':'+target},${target},${JSON.stringify(payload)}::jsonb) ON CONFLICT(workspace_id,dedupe_key) DO NOTHING`;}}
export async function queueTest(db: PrismaClient, ws: string,target?:string) {
    const { preferences: p } = await readPreferences(db, ws);
    if (!p.enabled)
        throw Error("Enable delivery and configure a destination first");
    if(target&&!deliveryTargets(p).includes(target))throw Error('Destination is not selected');
    const selected=target?{...p,destinations:[target]}:p;
    await db.$transaction(tx => enqueue(tx, ws, selected, 'test:' + randomUUID(), { kind: "test", text: "SpekTrace test notification. Delivery is configured; this is not an integration finding." }));
}
export async function collectNotifications(db: PrismaClient, ws: string, now = new Date()) {
    return db.$transaction(async (tx) => {
        await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${'notifications:' + ws}))::text`;
        const prefs = await tx.$queryRaw<PrefRow[]> `SELECT preferences,enabled_since,digest_cursor FROM notification_preferences WHERE workspace_id=${ws}::uuid`;
        if (!prefs[0])
            return { scanned: 0 };
        const p = preferencesSchema.parse(prefs[0].preferences);
        if (!p.enabled)
            return { scanned: 0 };
        // Membership is the durable cursor: late processing cannot fall behind a timestamp watermark.
        const rows = await tx.$queryRaw<{
            id: string;
        }[]> `SELECT o.id FROM integration_observations o WHERE o.workspace_id=${ws}::uuid AND o.processing_state='DONE' AND o.received_at>=${prefs[0].enabled_since} AND NOT EXISTS(SELECT 1 FROM notification_members m WHERE m.workspace_id=o.workspace_id AND m.observation_id=o.id) ORDER BY o.received_at,o.id LIMIT 100`;
        for (const row of rows) {
            const o = await loadObservation(db, ws, row.id);
            if (!o?.event || !o.evidence) {
                await tx.$executeRaw `INSERT INTO notification_groups(workspace_id,group_key,summary) VALUES(${ws}::uuid,'quiet','{"title":"Evidence withheld"}'::jsonb) ON CONFLICT DO NOTHING`;
                await tx.$executeRaw `INSERT INTO notification_members(workspace_id,group_key,observation_id) VALUES(${ws}::uuid,'quiet',${row.id}::uuid) ON CONFLICT DO NOTHING`;
                continue;
            }
            const finding = o.state === 'DRIFT' || o.state === 'CONTRACT_MISMATCH' ? o.state : o.event.result.kind !== 'HTTP' && o.event.result.kind !== 'ABORTED' ? o.event.result.kind : o.event.result.kind === 'HTTP' && o.event.result.statusCode >= 500 ? 'HTTP_5XX' : null;
            // Non-alert observations also receive membership so healthy traffic cannot starve later findings.
            const key = finding ? digest({ integration: o.integration, operation: o.operation, finding, baseline: o.evidence.baseline, changes: o.evidence.changes }) : 'quiet';
            const summary: Summary = { title: finding ? safeText(findingTitle(finding)) : 'Quiet', integration: o.event.integration.key, provider: o.event.integration.provider, environment: o.event.integration.environment, operation: o.event.operation.method + ' ' + o.event.operation.path, finding: finding ?? 'QUIET', changes: o.evidence.changes.map(c => safeText(c.pointer + ': ' + (c.expectedType ?? 'missing') + ' → ' + (c.receivedType ?? 'missing'))), observationId: o.id };
            await tx.$executeRaw `INSERT INTO notification_groups(workspace_id,group_key,summary) VALUES(${ws}::uuid,${key},${JSON.stringify(summary)}::jsonb) ON CONFLICT DO NOTHING`;
            await tx.$executeRaw `INSERT INTO notification_members(workspace_id,group_key,observation_id) VALUES(${ws}::uuid,${key},${row.id}::uuid) ON CONFLICT DO NOTHING`;
        }
        const groups = await tx.$queryRaw<{
            group_key: string;
            summary: Summary;
            notified_calls: number;
            notified_failed: number;
            updated_at: Date;
        }[]> `SELECT * FROM notification_groups WHERE workspace_id=${ws}::uuid AND group_key NOT IN ('quiet','capture-health') ORDER BY evaluated_at,group_key LIMIT 100`;
        for (const group of groups) {
            await tx.$executeRaw `UPDATE notification_groups SET evaluated_at=${now} WHERE workspace_id=${ws}::uuid AND group_key=${group.group_key}`;
            const counts = await tx.$queryRaw<{
                calls: bigint;
            }[]> `SELECT count(*) AS calls FROM notification_members WHERE workspace_id=${ws}::uuid AND group_key=${group.group_key}`;
            const members = await tx.$queryRaw<{
                observation_id: string;
            }[]> `SELECT observation_id FROM notification_members WHERE workspace_id=${ws}::uuid AND group_key=${group.group_key} ORDER BY observation_id LIMIT 100`;
            const failedIds = new Set<string>();
            let partial = Number(counts[0].calls) > 100;
            for (const member of members) {
                const o = await loadObservation(db, ws, member.observation_id);
                for (const outcome of o?.outcomes ?? [])
                    if (outcome.outcome === 'FAILED')
                        failedIds.add(outcome.id);
                partial ||= !!o?.linksTruncated;
            }
            const current = { calls: Number(counts[0].calls), failed: failedIds.size };
            await tx.$executeRaw`UPDATE notification_groups SET summary=summary||${JSON.stringify({currentFailed:current.failed,currentCalls:current.calls})}::jsonb WHERE workspace_id=${ws}::uuid AND group_key=${group.group_key}`;
            const baseAllowed=p.categories[findingCategory(group.summary.finding)],impactUpdate=p.categories.linkedFailures&&current.failed>group.notified_failed;
            const selected=baseAllowed||impactUpdate;
            const meaningful=baseAllowed?shouldUpdate({calls:group.notified_calls,failed:p.categories.linkedFailures?group.notified_failed:current.failed},current):impactUpdate;
            if(p.alerts&&selected&&(!group.notified_calls||(now.getTime()-group.updated_at.getTime()>=900000&&meaningful))){
                const s = group.summary;
                await enqueue(tx, ws, p, 'alert:' + group.group_key + ':' + current.calls + ':' + current.failed, { kind: 'alert', ...s,title:baseAllowed?s.title:'Linked workflow failure reported',...current, category:baseAllowed?findingCategory(s.finding):'linkedFailures',partial,text: [baseAllowed?s.title:'Linked workflow failure reported', s.integration + ' · ' + s.environment, s.operation, ...s.changes, current.calls + ' captured call(s); ' + current.failed + ' linked reported failed outcome(s).', 'Identifier association does not establish cause.', ...(partial ? ['Outcome evidence is bounded; counts are partial.'] : [])].join('\n') });
                await tx.$executeRaw `UPDATE notification_groups SET notified_calls=${current.calls},notified_failed=${current.failed},updated_at=${now} WHERE workspace_id=${ws}::uuid AND group_key=${group.group_key}`;
            }
        }
        const status=await integrationStatus(db,ws,now);
        const processingProblems=await tx.outboxEvent.count({where:{workspaceId:ws,eventType:{in:['INTEGRATION_OBSERVATION_REQUESTED','INTEGRATION_OUTCOME_REQUESTED']},OR:[{dispatchStatus:'FAILED'},{lastError:{not:null}}]}});
        const gapReports=status.coverage.filter(c=>c.counters.dropped>0||c.counters.deliveryUnconfirmed>0).length;
        const healthCount=processingProblems+gapReports;
        if(p.alerts&&p.categories.captureProblems&&healthCount){
          const previous=await tx.$queryRaw<{notified_calls:number;updated_at:Date}[]>`SELECT notified_calls,updated_at FROM notification_groups WHERE workspace_id=${ws}::uuid AND group_key='capture-health'`;
          if(!previous[0]||(previous[0].notified_calls!==healthCount&&now.getTime()-previous[0].updated_at.getTime()>=900000)){
          await enqueue(tx,ws,p,'health:'+healthCount+':'+Math.floor(now.getTime()/900000),{kind:'alert',category:'captureProblems',title:'Capture or processing needs attention',text:processingProblems+' queued processing problem(s); '+gapReports+' capture report(s) include dropped or unconfirmed deliveries. Reports may be cumulative; this does not establish a provider outage.'});
          await tx.$executeRaw`INSERT INTO notification_groups(workspace_id,group_key,summary,notified_calls) VALUES(${ws}::uuid,'capture-health','{}'::jsonb,${healthCount}) ON CONFLICT(workspace_id,group_key) DO UPDATE SET notified_calls=EXCLUDED.notified_calls,updated_at=${now}`;
          }
        }
        if (p.digest !== 'off' && digestPeriod(now, p.digest) !== digestPeriod(prefs[0].digest_cursor, p.digest)) {
            const since=new Date(now.getTime()-(p.digest==='weekly'?168:24)*3600000);
            const candidates=await tx.$queryRaw<{summary:Summary&{currentFailed?:number}}[]>`SELECT g.summary FROM notification_groups g WHERE g.workspace_id=${ws}::uuid AND g.group_key NOT IN('quiet','capture-health') AND EXISTS(SELECT 1 FROM notification_members m JOIN integration_observations o ON o.workspace_id=m.workspace_id AND o.id=m.observation_id WHERE m.workspace_id=g.workspace_id AND m.group_key=g.group_key AND (o.received_at>=${since} OR EXISTS(SELECT 1 FROM integration_outcome_links l JOIN integration_workflow_outcomes w ON w.workspace_id=l.workspace_id AND w.id=l.outcome_id WHERE l.workspace_id=o.workspace_id AND l.observation_id=o.id AND w.received_at>=${since}))) ORDER BY g.updated_at DESC LIMIT 101`;
            const selectedGroups=candidates.slice(0,100).filter(g=>p.categories[findingCategory(g.summary.finding)]||(p.categories.linkedFailures&&(g.summary.currentFailed??0)>0)).map(g=>({title:p.categories[findingCategory(g.summary.finding)]?g.summary.title:'Linked workflow failure reported',integration:g.summary.integration,environment:g.summary.environment,operation:g.summary.operation,changes:g.summary.changes}));
            const health=p.categories.captureProblems&&healthCount?healthCount+' current capture/processing problem indicator(s). ':'';
            await enqueue(tx,ws,p,'digest:'+p.digest+':'+digestPeriod(now,p.digest),{kind:'digest',categories:p.categories,frequency:p.digest,selectedFindings:selectedGroups,partial:candidates.length>100,text:'SpekTrace '+p.digest+' digest ('+(p.digest==='weekly'?'last 7 days':'last 24 hours')+'). '+selectedGroups.length+' finding group(s) in your selected categories. '+health+'Capture coverage may be incomplete.'+(candidates.length>100?' Finding groups are limited to 100.':'')+'\n'+selectedGroups.map(g=>g.integration+' · '+g.title+' · '+g.operation).join('\n')});
            await tx.$executeRaw `UPDATE notification_preferences SET digest_cursor=${now} WHERE workspace_id=${ws}::uuid`;
        }
        return { scanned: rows.length, groups: groups.length };
    }, { timeout: 60000 });
}
