import { loadNotificationInbox,handleInboxGet } from '@/server/notifications/inbox';
import { loadCompactAlert } from '@/server/notifications/alert-view';
import { handleOnboardingGet,handleOnboardingPost } from '@/server/notifications/onboarding-http';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { createPrismaClientForUrl } from '@/lib/db';
import { requireTestDatabaseUrl } from '@/lib/env';
import { observabilityFixture, drainIntegrationWork } from '../../scripts/lib/integration-observability-fixture';
import { ingestIntegrationEvent, ingestWorkflowOutcome } from '@/server/integration-observations/ingest';
import { projectSelectedShape } from '@/lib/integration-observations/shape';
import { manageResponseBaseline } from '@/server/integration-observations/baselines';
import { savePreferences, collectNotifications, queueTest, readPreferences } from '@/server/notifications/service';
import { deliverNotifications, destinations } from '@/server/notifications/delivery';
import { integrationStatus } from '@/server/notifications/status';
import { handleIntegrationStatus } from '@/server/notifications/http';
const statusGet = (r: Request) => handleIntegrationStatus(r, db);
const url = requireTestDatabaseUrl();
if (!/^spektrace_test_notify_[a-f0-9]{32}$/.test(new URL(url).pathname.slice(1)) || new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_NOTIFICATION_TEST_DATABASE)
    throw Error('Use npm run verify:notifications');
const db = createPrismaClientForUrl(url);
afterAll(async () => { vi.unstubAllEnvs(); await db.$disconnect(); });
const preference = { enabled: true, destination: 'default', alerts: true, digest: 'off' as const };
async function fixture() {
    const f = await observabilityFixture(db);
    const integration = { key: 'synthetic-crm', provider: 'fixture-crm', environment: 'test' };
    const operation = { method: 'GET' as const, path: '/contacts' };
    const correlation = { kind: 'workflow' as const, id: randomUUID(), attempt: 1 };
    async function call(count: number | string) { const e = { version: 1, kind: 'observation', sourceEventId: randomUUID(), callId: randomUUID(), attempt: 1, integration, operation, occurredAt: new Date().toISOString(), durationMs: 5, result: { kind: 'HTTP', originMatched: true, statusCode: 200, providerVersion: null }, capture: { state: 'CAPTURED', pointers: ['/count'], projection: projectSelectedShape({ count }, ['/count']), omission: null }, correlation, sampleRate: 1 }; const row = await ingestIntegrationEvent(db, f.key.token, e); await drainIntegrationWork(db, f.workspace.id); return row; }
    const sample = await call(1);
    const baseline = await manageResponseBaseline(db, f.workspace.id, { action: 'observe', observationId: sample.id });
    await manageResponseBaseline(db, f.workspace.id, { action: 'activate', baselineId: baseline.id });
    return { ...f, integration, correlation, call };
}
async function deliveries(ws: string) { return db.$queryRaw<{
    id: string;
    state: string;
    attempts: number;
    payload: {
        kind: string;
        calls: number;
        failed: number;
        text: string;
    };
    dedupe_key: string;
}[]> `SELECT * FROM notification_deliveries WHERE workspace_id=${ws}::uuid ORDER BY created_at,id`; }
describe('persistent notifications with synthetic evidence', () => {
    it('groups repeated drift, prevents reprocessing duplicates, and updates for a late failed outcome after cooldown', async () => {
        const f = await fixture(), ws = f.workspace.id;
        await savePreferences(db, ws, preference);
        await f.call('2');
        await collectNotifications(db, ws);
        expect(await deliveries(ws)).toHaveLength(1);
        await f.call('3');
        await collectNotifications(db, ws);
        expect(await deliveries(ws)).toHaveLength(1);
        await ingestWorkflowOutcome(db, f.key.token, { version: 1, sourceEventId: randomUUID(), integration: f.integration, correlation: f.correlation, outcome: 'FAILED', occurredAt: new Date().toISOString() });
        await drainIntegrationWork(db, ws);
        await collectNotifications(db, ws);
        expect(await deliveries(ws)).toHaveLength(1);
        await collectNotifications(db, ws, new Date(Date.now() + 16 * 60000));
        const all = await deliveries(ws);
        expect(all).toHaveLength(2);
        expect(all[1].payload.failed).toBe(1);
        expect(all[1].payload.calls).toBe(2);
        expect(all[1].payload.text).toContain('does not establish cause');
        await collectNotifications(db, ws, new Date(Date.now() + 17 * 60000));
        expect(await deliveries(ws)).toHaveLength(2);
    }, 30000);
    it('isolates tenants and queues nothing while disabled', async () => { const a = await fixture(), b = await fixture(); await savePreferences(db, a.workspace.id, preference); await b.call('x'); await collectNotifications(db, a.workspace.id); await collectNotifications(db, b.workspace.id); expect(await deliveries(a.workspace.id)).toHaveLength(0); expect(await deliveries(b.workspace.id)).toHaveLength(0); expect((await readPreferences(db, b.workspace.id)).preferences.enabled).toBe(false); }, 30000);
    it('retries delivery using the same ID, signs the exact body, and cancels queued messages when disabled', async () => {
        const f = await fixture(), ws = f.workspace.id;
        await savePreferences(db, ws, preference);
        await queueTest(db, ws);
        const secret = 'a'.repeat(32);
        vi.stubEnv('SPEKTRACE_NOTIFICATION_DESTINATIONS', JSON.stringify({ default: { kind: 'webhook', url: 'https://receiver.example/spek', signingSecret: secret } }));
        const target = (await deliveries(ws))[0].id;
        const requests: RequestInit[] = [];
        const transport = vi.fn(async (_input: unknown, init?: RequestInit) => { if (new Headers(init?.headers).get('x-spektrace-delivery-id') !== target)
            return new Response('', { status: 202 }); requests.push(init!); return new Response('', { status: requests.length === 1 ? 503 : 202 }); }) as unknown as typeof fetch;
        await deliverNotifications(db, new Date(), transport);
        let rows = await deliveries(ws);
        expect(rows[0].state).toBe('PENDING');
        await deliverNotifications(db, new Date(Date.now() + 61000), transport);
        rows = await deliveries(ws);
        expect(rows[0].state).toBe('SENT');
        expect(rows[0].attempts).toBe(2);
        const h1 = new Headers(requests[0].headers), h2 = new Headers(requests[1].headers);
        expect(h1.get('x-spektrace-delivery-id')).toBe(h2.get('x-spektrace-delivery-id'));
        expect(h2.get('x-spektrace-signature')).toBe('sha256=' + createHmac('sha256', secret).update(h2.get('x-spektrace-timestamp') + '.' + requests[1].body).digest('hex'));
        await queueTest(db, ws);
        await savePreferences(db, ws, { ...preference, enabled: false });
        expect((await deliveries(ws)).filter(d => d.state === 'CANCELLED')).toHaveLength(1);
    }, 30000);
    it('queues one digest per UTC period and uses a seven-day window for weekly digests', async () => { const f = await fixture(), ws = f.workspace.id; await savePreferences(db, ws, { ...preference, alerts: false, digest: 'weekly' }); await f.call('changed'); await db.$executeRaw `UPDATE notification_preferences SET digest_cursor='2026-01-01'::timestamptz WHERE workspace_id=${ws}::uuid`; const now = new Date(); await collectNotifications(db, ws, now); await collectNotifications(db, ws, now); const rows = await deliveries(ws); expect(rows).toHaveLength(1); expect(rows[0].payload.kind).toBe('digest'); expect(rows[0].payload.text).toContain('last 7 days'); }, 30000);
    it('distinguishes empty capture from health and requires admin authorization for status', async () => { const f = await observabilityFixture(db); const status = await integrationStatus(db, f.workspace.id); expect(status.capturedCalls).toBe(0); const weekly=await integrationStatus(db,f.workspace.id,new Date(),168);expect(weekly.limitations.join(' ')).toContain('168 hours'); expect(status.coverage).toHaveLength(0); expect(status.limitations.join(' ')).toContain('not all API traffic'); vi.stubEnv('SPEKTRACE_INTERNAL_WORKSPACE_ID', f.workspace.id); vi.stubEnv('SPEKTRACE_INTERNAL_API_TOKEN', f.adminToken); expect((await statusGet(new Request('http://127.0.0.1/api/internal/integration-status'))).status).toBe(401); expect((await statusGet(new Request('http://127.0.0.1/api/internal/integration-status', { headers: { authorization: 'Bearer ' + f.key.token } }))).status).toBe(401); expect((await statusGet(new Request('http://127.0.0.1/api/internal/integration-status', { headers: { authorization: 'Bearer ' + f.adminToken } }))).status).toBe(200); });
    it('refuses insecure or malformed server destinations without exposing their URLs', () => { vi.stubEnv('SPEKTRACE_NOTIFICATION_DESTINATIONS', JSON.stringify({ default: { kind: 'webhook', url: 'http://receiver.example', signingSecret: 'a'.repeat(32) } })); expect(() => destinations()).toThrow('Invalid notification destination'); vi.stubEnv('SPEKTRACE_NOTIFICATION_DESTINATIONS', '{}'); });
 it('verifies onboarding receipt and baseline from the selected scope, saves real preferences, and rejects cross-site writes',async()=>{
 const f=await fixture(),ws=f.workspace.id;vi.stubEnv('NODE_ENV','development');vi.stubEnv('SPEKTRACE_INTERNAL_WORKSPACE_ID',ws);vi.stubEnv('SPEKTRACE_NOTIFICATION_DESTINATIONS','{}');
 const query=new URLSearchParams({key:f.integration.key,provider:f.integration.provider,environment:f.integration.environment});let response=await handleOnboardingGet(new Request('http://127.0.0.1:3000/api/dashboard/onboarding?'+query),db);expect(response.status).toBe(200);const data=await response.json();expect(data.firstCall.id).toBeTruthy();expect(data.baselineReady).toBe(true);expect(data.destinations).toEqual([]);
 const post=(origin:string,enabled:boolean)=>new Request('http://127.0.0.1:3000/api/dashboard/onboarding',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({action:'preferences',preferences:{...preference,enabled}})});
 expect((await handleOnboardingPost(post('http://evil.example',false),db)).status).toBe(403);expect((await handleOnboardingPost(post('http://127.0.0.1:3000',true),db)).status).toBe(422);expect((await handleOnboardingPost(post('http://127.0.0.1:3000',false),db)).status).toBe(200);expect((await readPreferences(db,ws)).preferences.enabled).toBe(false);
 const empty=new URLSearchParams({key:f.integration.key,provider:f.integration.provider,environment:'different'});response=await handleOnboardingGet(new Request('http://127.0.0.1:3000/api/dashboard/onboarding?'+empty),db);expect((await response.json()).firstCall).toBeNull();vi.unstubAllEnvs();
 },30000);
 it('does not cancel an already queued alert when preferences are saved unchanged',async()=>{const f=await fixture(),ws=f.workspace.id;await savePreferences(db,ws,preference);await f.call('changed');await collectNotifications(db,ws);await savePreferences(db,ws,preference);expect((await deliveries(ws))[0].state).toBe('PENDING');},30000);

 it('bounds repeated delivery failure and does not resurrect an exhausted interrupted lease',async()=>{const f=await fixture(),ws=f.workspace.id;await savePreferences(db,ws,preference);await queueTest(db,ws);const id=(await deliveries(ws))[0].id;vi.stubEnv('SPEKTRACE_NOTIFICATION_DESTINATIONS',JSON.stringify({default:{kind:'webhook',url:'https://receiver.example',signingSecret:'a'.repeat(32)}}));await db.$executeRaw`UPDATE notification_deliveries SET state='SENDING',attempts=5,available_at=now()-interval '1 minute' WHERE id=${id}::uuid`;let targetAttempts=0;const transport=(async(_url:unknown,init?:RequestInit)=>{if(new Headers(init?.headers).get('x-spektrace-delivery-id')===id)targetAttempts++;return new Response('',{status:503});}) as typeof fetch;await deliverNotifications(db,new Date(),transport);expect((await deliveries(ws))[0].state).toBe('FAILED');expect((await deliveries(ws))[0].attempts).toBe(5);expect(targetAttempts).toBe(0);vi.unstubAllEnvs();},30000);

 it('does not send unchecked structure changes, but can alert on a newly linked failure independently',async()=>{const f=await fixture(),ws=f.workspace.id;await savePreferences(db,ws,{...preference,categories:{responseStructure:false,linkedFailures:false}});await f.call('changed');await collectNotifications(db,ws);expect(await deliveries(ws)).toHaveLength(0);await ingestWorkflowOutcome(db,f.key.token,{version:1,sourceEventId:randomUUID(),integration:f.integration,correlation:f.correlation,outcome:'FAILED',occurredAt:new Date().toISOString()});await drainIntegrationWork(db,ws);await collectNotifications(db,ws);expect(await deliveries(ws)).toHaveLength(0);await savePreferences(db,ws,{...preference,categories:{responseStructure:false,linkedFailures:true}});await collectNotifications(db,ws);const rows=await deliveries(ws);expect(rows).toHaveLength(1);expect(rows[0].payload.text).toContain('Linked workflow failure reported');},30000);
 it('excludes unchecked findings from digests and cancels a queued digest after preferences change',async()=>{const f=await fixture(),ws=f.workspace.id;await savePreferences(db,ws,{...preference,digest:'daily',categories:{responseStructure:false,linkedFailures:false}});await f.call('changed');await db.$executeRaw`UPDATE notification_preferences SET digest_cursor='2026-01-01'::timestamptz WHERE workspace_id=${ws}::uuid`;await collectNotifications(db,ws);const rows=await deliveries(ws);expect(rows).toHaveLength(1);expect(rows[0].payload.kind).toBe('digest');expect(rows[0].payload.text).toContain('0 finding group(s)');expect(rows[0].payload.text).not.toContain('DRIFT');await savePreferences(db,ws,{...preference,digest:'daily',categories:{availability:false}});expect((await deliveries(ws))[0].state).toBe('CANCELLED');},30000);
 it('reports processing trouble only when its category is selected',async()=>{const f=await fixture(),ws=f.workspace.id;await savePreferences(db,ws,{...preference,categories:{captureProblems:false}});await db.outboxEvent.updateMany({where:{workspaceId:ws},data:{dispatchStatus:'FAILED',lastError:'Synthetic processing problem'}});await collectNotifications(db,ws);expect(await deliveries(ws)).toHaveLength(0);await savePreferences(db,ws,preference);await collectNotifications(db,ws);expect((await deliveries(ws))[0].payload.text).toContain('processing problem');},30000);

 it('opens a queued finding with its validated baseline and linked outcome evidence',async()=>{const f=await fixture(),ws=f.workspace.id;await savePreferences(db,ws,preference);const call=await f.call('changed');await ingestWorkflowOutcome(db,f.key.token,{version:1,sourceEventId:randomUUID(),integration:f.integration,correlation:f.correlation,outcome:'FAILED',occurredAt:new Date().toISOString()});await drainIntegrationWork(db,ws);await collectNotifications(db,ws);const row=(await deliveries(ws)).find(r=>r.payload.kind==='alert')!;const detail=await loadCompactAlert(db,ws,row.id);expect(detail?.observation?.id).toBe(call.id);expect(detail?.observation?.evidence?.code).toBe('DRIFT');expect(detail?.observation?.baseline?.origin).toBe('OBSERVED');expect(detail?.observation?.outcomes[0].outcome).toBe('FAILED');expect(detail?.payload.text).toContain('/alerts/'+row.id);},30000);

});

describe('header notification inbox',()=>{
it('paginates all retained notifications without exposing another workspace or message bodies',async()=>{const ws=await db.workspace.create({data:{name:'Inbox test',slug:randomUUID()}}),other=await db.workspace.create({data:{name:'Other inbox',slug:randomUUID()}}),marker='foreign-'+randomUUID(),bodyMarker='private-body-'+randomUUID();await db.notificationDelivery.createMany({data:Array.from({length:21},(_,i)=>({id:randomUUID(),workspaceId:ws.id,dedupeKey:randomUUID(),destination:'synthetic',payload:{kind:'alert',title:'Finding '+i,text:bodyMarker,integration:'crm',environment:'test'},state:'SENT',createdAt:new Date(Date.now()-i*1000)}))});await db.notificationDelivery.create({data:{id:randomUUID(),workspaceId:other.id,dedupeKey:randomUUID(),destination:'synthetic',payload:{kind:'alert',title:marker,text:bodyMarker},state:'SENT'}});const first=await loadNotificationInbox(db,ws.id),second=await loadNotificationInbox(db,ws.id,2);expect(first.total).toBe(21);expect(first.items).toHaveLength(20);expect(first.hasMore).toBe(true);expect(second.items).toHaveLength(1);expect(second.hasMore).toBe(false);expect(new Set([...first.items,...second.items].map(i=>i.id)).size).toBe(21);expect(JSON.stringify(first)+JSON.stringify(second)).not.toContain(marker);expect(JSON.stringify(first)).not.toContain(bodyMarker);expect((await loadNotificationInbox(db,other.id)).items[0].title).toBe(marker);await expect(loadNotificationInbox(db,ws.id,0)).rejects.toThrow('Invalid page');});
it('rejects invalid pages and unsigned account requests before returning inbox data',async()=>{vi.stubEnv('NODE_ENV','development');vi.stubEnv('SPEKTRACE_ACCOUNTS_ENABLED','false');try{expect((await handleInboxGet(new Request('http://127.0.0.1:3000/api/dashboard/notifications?page=0'),db)).status).toBe(400);expect((await handleInboxGet(new Request('http://untrusted.invalid/api/dashboard/notifications'),db)).status).toBe(404);vi.stubEnv('SPEKTRACE_ACCOUNTS_ENABLED','true');vi.stubEnv('BETTER_AUTH_URL','http://127.0.0.1:3000');vi.stubEnv('BETTER_AUTH_SECRET','');expect((await handleInboxGet(new Request('http://127.0.0.1:3000/api/dashboard/notifications'),db)).status).toBe(401);}finally{vi.unstubAllEnvs();}});
});
