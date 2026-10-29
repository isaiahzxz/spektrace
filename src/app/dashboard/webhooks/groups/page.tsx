import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { panel, focusRing, secondaryAction } from "@/components/dashboard/styles";
import { GroupingNote, WebhookViews, WebhookGroupList } from "@/components/dashboard/webhook-groups-view";
import { WebhookRefresh } from "@/components/dashboard/webhook-refresh";
import { parseWebhookFilters } from "@/lib/dashboard/webhook-receipts";
import { getPrisma } from "@/lib/db";

import { listWebhookGroups } from "@/server/dashboard/webhook-groups";

export const metadata: Metadata = { title: "Webhook drift groups · SpekTrace", robots: { index: false, follow: false } };
async function GroupsBody({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection(); const parsed = parseWebhookFilters(await searchParams); const filters = parsed.success ? parsed.data : { page: 1 };
  let result: Awaited<ReturnType<typeof listWebhookGroups>> | null = null;
  if (parsed.success) { try { result = await listWebhookGroups(getPrisma(), (await getDashboardWorkspaceId()), filters); } catch { /* Keep storage failure distinct from empty. */ } }
  return <main className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-[96rem] space-y-5">
    <header><h1 className="text-xl font-semibold">Webhook drift groups</h1><p className="mt-1 text-xs text-st-muted">Environment · {filters.environment ?? "All environments"}</p>
      <p className="mt-3 text-sm text-st-muted">Signed synthetic webhook mismatches grouped by sender, drift, pinned revision and received-time window.</p></header>
    <WebhookViews filters={filters} active="groups" /><GroupingNote />
    <div className="flex flex-wrap items-end justify-between gap-4"><form method="get" className="flex flex-wrap items-end gap-3">
      <label className="text-xs text-st-muted">Service<input name="svc" defaultValue={filters.service ?? ""} placeholder="All services" className={`mt-1 block min-h-11 w-56 max-w-full rounded-md border border-st-muted/70 bg-base-200 px-3 text-sm text-base-content ${focusRing}`} /></label>
      <label className="text-xs text-st-muted">Environment<input name="env" defaultValue={filters.environment ?? ""} placeholder="All environments" className={`mt-1 block min-h-11 w-48 max-w-full rounded-md border border-st-muted/70 bg-base-200 px-3 text-sm text-base-content ${focusRing}`} /></label>
      <button className={secondaryAction} type="submit">Apply filters</button></form><WebhookRefresh watch={false} subject="groups" /></div>
    {result ? <WebhookGroupList rows={result.rows} total={result.total} filters={filters} /> : <section className={`${panel} p-6`} role="status"><h2 className="font-medium">{parsed.success ? "Groups could not be loaded" : "Invalid group filters"}</h2>
      <p className="mt-2 text-sm text-st-muted">{parsed.success ? "The group store is unavailable. Refresh to try again; this does not mean there are no groups." : "Use a valid service, environment and positive page number."}</p></section>}
  </div></main>;
}
export default function WebhookGroupsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return <DashboardFrame><Suspense fallback={<main className="p-6" aria-busy="true">Loading webhook drift groups.</main>}><GroupsBody searchParams={searchParams} /></Suspense></DashboardFrame>;
}
