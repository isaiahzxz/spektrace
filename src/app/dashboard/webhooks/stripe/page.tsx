import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { WebhookViews } from "@/components/dashboard/webhook-groups-view";
import { StripeAcceptanceNote, StripeReceiptList, StripeScopeNotice } from "@/components/dashboard/stripe-receipt-view";
import { WebhookRefresh } from "@/components/dashboard/webhook-refresh";
import { panel, focusRing, secondaryAction } from "@/components/dashboard/styles";
import { parseStripeReceiptFilters } from "@/lib/dashboard/stripe-receipts";
import { getPrisma } from "@/lib/db";

import { listStripeReceipts } from "@/server/dashboard/stripe-receipts";

export const metadata: Metadata = { title: "Stripe receipts · SpekTrace", robots: { index: false, follow: false } };
async function StripeBody({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const parsed = parseStripeReceiptFilters(await searchParams);
  if (!parsed.success) return <main className="h-full overflow-y-auto p-4 sm:p-6"><h1 className="text-xl font-semibold">Stripe test receipts</h1><p className="mt-6">Invalid receipt filters. Use a valid integration UUID and positive page number.</p></main>;
  const filters = parsed.data;
  let result: Awaited<ReturnType<typeof listStripeReceipts>> | null = null;
  try { result = await listStripeReceipts(getPrisma(), (await getDashboardWorkspaceId()), filters); } catch { /* Show failure separately from empty results. */ }
  return <main className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-[96rem] space-y-5">
    <header><h1 className="text-xl font-semibold">Stripe test receipts</h1><p className="mt-2 max-w-3xl text-sm text-st-muted">Read-only acceptance records and selected field shapes. Service and deployment environment are not recorded.</p></header>
    <WebhookViews filters={filters} active="stripe" /><StripeAcceptanceNote />
    <div className="flex flex-wrap items-end justify-between gap-4"><form method="get" className="flex flex-wrap items-end gap-3">
      {filters.environment ? <input type="hidden" name="env" value={filters.environment} /> : null}{filters.service ? <input type="hidden" name="svc" value={filters.service} /> : null}
      <label className="text-xs text-st-muted">Configured integration ID<input name="integration" defaultValue={filters.integrationId ?? ""} placeholder="All integrations" className={`mt-1 block min-h-11 w-80 max-w-full rounded-md border border-st-muted/70 bg-base-200 px-3 text-sm text-base-content ${focusRing}`} /></label>
      <button type="submit" className={secondaryAction}>Apply filter</button></form><WebhookRefresh watch={Boolean(result?.rows.some(row => row.state === "Pending"))} /></div>
    {!result ? <section className={`${panel} p-6`} role="status"><h2 className="font-medium">Stripe receipts could not be loaded</h2><p className="mt-2 text-sm text-st-muted">The receipt store is unavailable. Refresh to try again; this does not mean there are no receipts.</p></section> : result.scopeUnsupported ? <StripeScopeNotice filters={filters} /> : <StripeReceiptList rows={result.rows} total={result.total} filters={filters} />}
  </div></main>;
}
export default function StripeReceiptsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return <DashboardFrame><Suspense fallback={<main className="p-6" aria-busy="true">Loading Stripe receipts.</main>}><StripeBody searchParams={searchParams} /></Suspense></DashboardFrame>;
}
