"use client";
import { useState } from "react";
import { defaultPreferences, deliveryTargets,alertCategoryLabels,type AlertCategory,type NotificationPreferences } from "@/lib/notifications/policy";
import { CompactAlertLink } from "./compact-alert-link";
import { panel, secondaryAction, focusRing } from "./styles";
export type SetupStatus = {
    workspaceId: string;
    credentialReady: boolean;
    preferences: NotificationPreferences;
    destinations: {
        key: string;
        kind: string;
    }[];
    history: {
        id: string;
        state: string;
        destination?:string;kind?:string;
        attempts: number;
        created_at: string;
        sent_at: string | null;
    }[];
    firstCall: {
        id: string;
        processingState: string;
        receivedAt: string;
    } | null;
    baselineReady: boolean;
    outcomes: number;
};
export function NotificationPreferencesForm({ data, onRefresh }: {
    data: SetupStatus;
    onRefresh: () => void;
}) {
    const [prefs, setPrefs] = useState(()=>{const p=data.preferences??defaultPreferences;return {...p,alerts:true,destinations:deliveryTargets(p).filter(key=>['slack','email'].includes(key)||['slack','email'].includes(data.destinations.find(d=>d.key===key)?.kind??''))};}), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
    const [testDestination,setTestDestination]=useState('');
    const selectedTargets=deliveryTargets(prefs);
    const dirty = JSON.stringify(prefs) !== JSON.stringify(data.preferences);
    const input = 'mt-2 block min-h-11 w-full rounded-md border border-base-300 bg-base-100 px-3 ' + focusRing;
    async function submit(action: 'preferences' | 'test') { setBusy(true); setMessage(''); setError(''); try {
        const response = await fetch('/api/dashboard/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action === 'test' ? { action,destination:testDestination||selectedTargets[0] } : { action, preferences: prefs }) });
        const text=await response.text();let result:{error?:string};try{result=JSON.parse(text);}catch{throw Error("The local server did not return a setup response. Refresh the page and try again.");}
        if (!response.ok)
            throw Error(result.error ?? 'Request failed');
        setMessage(action === 'test' ? 'Test queued. The notification worker must deliver it; check delivery history below.' : 'Preferences saved.');
        onRefresh();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed');
    }
    finally {
        setBusy(false);
    } }
    return <div className="space-y-5">
 <div><h2 className="text-lg font-semibold">Hear about changes where you work</h2><p className="mt-2 text-sm text-st-muted">New findings are grouped. Updates are limited to meaningful changes in captured volume or linked failed outcomes.</p></div>
 {data.preferences.enabled&&deliveryTargets(data.preferences).some(key=>data.destinations.find(d=>d.key===key)?.kind==='webhook')&&<p role="status" className="text-sm">A legacy webhook destination is active. Choose Slack or email and save to replace it; existing preferences remain active until saved.</p>}
 <fieldset disabled={busy} className="space-y-4"><legend className="sr-only">Notification preferences</legend>
 <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className={focusRing} checked={prefs.enabled} onChange={e => setPrefs({ ...prefs, enabled: e.target.checked })}/>Enable external delivery</label>
 <fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">Where should notifications go?</legend>{(['slack','email'] as const).map(kind=>{const configured=data.destinations.filter(d=>d.kind===kind),key=configured[0]?.key??kind;return <div key={kind}><label className="flex min-h-11 items-center gap-3"><input type="checkbox" className={focusRing} checked={selectedTargets.includes(key)} onChange={e=>setPrefs({...prefs,destinations:e.target.checked?[...selectedTargets.filter(t=>data.destinations.find(d=>d.key===t)?.kind!==kind),key]:selectedTargets.filter(t=>t!==key)})}/>{kind==='slack'?'Slack':'Email'}</label>{configured.length>1&&<label className="block text-xs">{kind==='slack'?'Slack destination':'Email destination'}<select className={input} value={selectedTargets.find(t=>configured.some(d=>d.key===t))??key} onChange={e=>setPrefs({...prefs,destinations:[...selectedTargets.filter(t=>!configured.some(d=>d.key===t)),e.target.value]})}>{configured.map(d=><option key={d.key} value={d.key}>{d.key}</option>)}</select></label>}{!configured.length&&<p className="ml-7 text-xs text-st-muted">{kind==='slack'?'Connect a Slack incoming webhook on the server.':'Configure the mail sender; signed-in accounts receive email at their verified address.'}</p>}</div>;})}</fieldset>
 <fieldset className="space-y-2 border-t border-base-300 pt-5"><legend className="mb-3 pt-5 text-sm font-medium">What should we alert you about?</legend>{Object.entries(alertCategoryLabels).map(([key,label])=><label className="flex min-h-11 items-center gap-3 text-sm" key={key}><input type="checkbox" className={focusRing} checked={prefs.categories[key as AlertCategory]} onChange={e=>setPrefs({...prefs,categories:{...prefs.categories,[key]:e.target.checked}})}/>{label}</label>)}<p className="text-xs text-st-muted">Checked categories can send alerts. Unchecked categories are excluded from alerts and digests. Repeated findings remain grouped.</p></fieldset>
 <label className="block text-sm">Digest<select className={input} value={prefs.digest} onChange={e => setPrefs({ ...prefs, digest: e.target.value as NotificationPreferences['digest'] })}><option value="off">Off</option><option value="daily">Daily · UTC day boundary</option><option value="weekly">Weekly · Monday UTC</option></select></label>
 <p className="text-xs text-st-muted">Delivery starts from activation; existing calls are not backfilled into alerts. Digests are generated when the worker next runs after the UTC boundary. Disabling delivery cancels queued messages.</p>
 <div className="flex flex-wrap gap-3"><button type="button" className={secondaryAction} onClick={() => void submit('preferences')}>{busy ? 'Working…' : 'Save preferences'}</button><label className="text-sm">Test destination<select className={input} value={testDestination||selectedTargets[0]||''} onChange={e=>setTestDestination(e.target.value)}>{!selectedTargets.length&&<option value="">Choose Slack or email</option>}{selectedTargets.map(key=><option value={key} key={key}>{data.destinations.find(d=>d.key===key)?.kind??key} · {key}</option>)}</select></label><button type="button" disabled={busy || dirty || !data.preferences.enabled || !selectedTargets.length} className={secondaryAction + ' disabled:opacity-50'} onClick={() => void submit('test')}>Send test notification</button></div></fieldset>
 {message && <p role="status" className="text-sm">{message}</p>}{error && <p role="alert" className="text-sm text-error">{error}</p>}
 <details className="text-sm"><summary className={'min-h-11 cursor-pointer py-3 '+focusRing}>Server connection instructions</summary><p className="mt-3">Configure private SPEKTRACE_NOTIFICATION_DESTINATIONS aliases for Slack and email. Slack uses an incoming webhook URL. Email uses SPEKTRACE_EMAIL_API_KEY and SPEKTRACE_EMAIL_FROM; account recipients must be verified. The existing worker sends queued messages. No keys or URLs are stored in this form.</p></details>
 <CompactAlertLink href="/alerts/preview" label="Preview the alert window"/><section className={panel + ' p-4'}><h3 className="font-medium">Notification preview <span className="text-xs text-st-muted">· illustrative example</span></h3><p className="mt-3 text-sm">Response shape changed · CRM / development</p><p className="mt-2 font-mono text-xs">GET /contacts · /count: integer → string</p><p className="mt-2 text-sm text-st-muted">12 captured calls; 3 linked reported failed outcomes. Identifier association does not establish cause.</p></section>
 <section><h3 className="font-medium">Recent delivery attempts</h3>{data.history.length ? <ul className="mt-2 divide-y divide-base-300">{data.history.map(h => <li key={h.id} className="flex flex-wrap justify-between gap-2 py-3 text-xs"><span>{h.destination??'Destination'} · {h.state} · {h.attempts} attempt(s)</span><time>{new Date(h.created_at).toLocaleString()}</time><CompactAlertLink href={'/alerts/'+h.id} label="View alert"/></li>)}</ul> : <p className="mt-2 text-sm text-st-muted">No messages queued. A queued test is not proof of delivery.</p>}</section>
 </div>;
}
