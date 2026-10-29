import { workspaceEmailRecipients } from "./recipients";
import { allowLocalDashboard as local, readSetupJson } from "@/lib/http/local-dashboard";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { requestWorkspace } from "@/server/accounts/workspace";
import { identitySchema } from "@/lib/integration-observations/contract";
import { loadIntegrationDirectory } from "@/server/dashboard/integrations";
import { readPreferences, savePreferences, queueTest } from "@/server/notifications/service";
import { destinationsForWorkspace, deliveryHistory } from "@/server/notifications/delivery";
export async function handleOnboardingGet(request: Request, db:PrismaClient) {
    if (!local(request))
        return new Response(null, { status: 404 });
    try {
        const u = new URL(request.url), parsed = identitySchema.safeParse({ key: u.searchParams.get('key'), provider: u.searchParams.get('provider'), environment: u.searchParams.get('environment') });
        const ws = await requestWorkspace(request,db);
        const scope = parsed.success ? { svc: parsed.data.key, provider: parsed.data.provider, env: parsed.data.environment } : {};
        const [directory, prefs, history, last, baseline, outcomes] = await Promise.all([loadIntegrationDirectory(db, ws, scope), readPreferences(db, ws), deliveryHistory(db, ws), parsed.success ? db.integrationObservation.findFirst({ where: { workspaceId: ws, integrationKey: parsed.data.key, providerKey: parsed.data.provider, environment: parsed.data.environment }, orderBy: { receivedAt: 'desc' }, select: { id: true, processingState: true, receivedAt: true } }) : null, parsed.success ? db.integrationResponseBaseline.count({ where: { workspaceId: ws, integrationKey: parsed.data.key, providerKey: parsed.data.provider, environment: parsed.data.environment, active: true } }) : 0, parsed.success ? db.integrationWorkflowOutcome.count({ where: { workspaceId: ws, integrationKey: parsed.data.key, providerKey: parsed.data.provider, environment: parsed.data.environment } }) : 0]);
        return Response.json({ workspaceId: ws, credentialReady: directory.credentialCount > 0, preferences: prefs.preferences, destinations: Object.entries(destinationsForWorkspace(ws)).map(([key, d]) => ({ key, kind: d.kind })), history, firstCall: last, baselineReady: baseline > 0, outcomes, integrations: directory.integrations }, { headers: { 'cache-control': 'no-store' } });
    }
    catch {
        return Response.json({ error: 'Setup could not be loaded. Check database migrations and server destination configuration.' }, { status: 503 });
    }
}
export async function handleOnboardingPost(request: Request, db:PrismaClient) {
    if (!local(request, true))
        return Response.json({error:"Save changes from the local SpekTrace page on the same port."}, { status: 403 });
    try {
        const input = z.discriminatedUnion('action', [z.object({ action: z.literal('preferences'), preferences: z.unknown() }).strict(), z.object({ action: z.literal('test'),destination:z.string().optional() }).strict()]).parse(await readSetupJson(request));
        const ws = await requestWorkspace(request,db);
        if (input.action === 'preferences') {
            const { preferencesSchema } = await import('@/lib/notifications/policy');
            const p = preferencesSchema.parse(input.preferences);
            if (p.enabled && (!(p.destinations??[p.destination]).length||(p.destinations??[p.destination]).some(key=>!destinationsForWorkspace(ws)[key])))
                return Response.json({ error: 'Configure this destination on the server before enabling delivery.' }, { status: 422 });
            if(p.enabled){for(const key of p.destinations??[p.destination]){const destination=destinationsForWorkspace(ws)[key];if(destination?.kind==='email'&&(!process.env.SPEKTRACE_EMAIL_API_KEY||!process.env.SPEKTRACE_EMAIL_FROM||!(await workspaceEmailRecipients(db,ws,destination.to)).length))return Response.json({error:'Configure the email sender and a verified recipient before enabling email.'},{status:422});}}
            await savePreferences(db, ws, p);
        }
        else {
            await queueTest(db, ws,input.destination);
        }
        return Response.json({ ok: true });
    }
    catch {
        return Response.json({ error: 'Preferences could not be saved or test queued. Check configuration.' }, { status: 400 });
    }
}
