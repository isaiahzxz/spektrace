import { Suspense } from 'react';import { connection } from 'next/server';import { AccountForm } from '@/components/dashboard/account-form';import { authCapabilities } from '@/server/accounts/auth';
export const metadata={title:'Sign in · SpekTrace',robots:{index:false,follow:false}};
async function Body({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){await connection();const params=await searchParams;return <AccountForm signup={false} capabilities={authCapabilities()} next={typeof params.next==='string'?params.next:undefined}/>;}
export default function Page(p:{searchParams:Promise<Record<string,string|string[]|undefined>>}){return <Suspense fallback={<p className="p-6">Loading account access…</p>}><Body {...p}/></Suspense>;}
