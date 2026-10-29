import { redirect,notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { dashboardDestination,type RawParams } from '@/lib/dashboard/mvp-navigation';
import { DashboardFrame } from '@/components/dashboard/dashboard-frame';
import { WorkspaceOverview } from '@/components/dashboard/workspace-overview';
import { getDashboardWorkspaceId } from '@/server/accounts/workspace';
import { loadWorkspaceOverview } from '@/server/dashboard/workspace-overview';
import { getPrisma } from '@/lib/db';
export const metadata:Metadata={title:'Overview · SpekTrace',robots:{index:false,follow:false}};
async function Entry({searchParams}:{searchParams:Promise<RawParams>}){await connection();const raw=await searchParams,target=dashboardDestination(raw);if(target!=='/dashboard')redirect(target);const workspaceId=await getDashboardWorkspaceId('/dashboard');let data;try{data=await loadWorkspaceOverview(getPrisma(),workspaceId);}catch{return <main className="p-8"><h1 className="text-xl font-medium">Overview unavailable</h1><p className="mt-3 text-sm text-st-muted">Workspace data could not be loaded. Refresh to try again.</p></main>;}return <WorkspaceOverview data={data}/>;}
export default function Page(props:{searchParams:Promise<RawParams>}){if(process.env.NODE_ENV!=='development'&&process.env.SPEKTRACE_ACCOUNTS_ENABLED!=='true')notFound();return <DashboardFrame><Suspense fallback={<p className="p-8" role="status">Loading overview…</p>}><Entry {...props}/></Suspense></DashboardFrame>}
