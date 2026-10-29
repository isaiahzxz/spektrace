import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { panel, focusRing, secondaryAction } from "@/components/dashboard/styles";
import { WebhookAcceptanceNote, WebhookReceiptList } from "@/components/dashboard/webhook-receipt-view";
import { WebhookRefresh } from "@/components/dashboard/webhook-refresh";
import { parseWebhookFilters } from "@/lib/dashboard/webhook-receipts";
import { getPrisma } from "@/lib/db";

import { listWebhookReceipts } from "@/server/dashboard/webhook-receipts";
import { WebhookViews } from "@/components/dashboard/webhook-groups-view";

export const metadata: Metadata = { title: "Accepted webhooks · SpekTrace", robots: { index: false, follow: false } };
async function WebhooksBody({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const filters = parseWebhookFilters(await searchParams);
  if (!filters.success) return <main className="h-full overflow-y-auto p-4 sm:p-6"><h1 className="text-xl font-semibold">Accepted webhooks</h1><p className="mt-6">The receipt filters are invalid. Use a valid service, environment and positive page number.</p></main>;
  let result: Awaited<ReturnType<typeof listWebhookReceipts>> | null = null;
  try { result = await listWebhookReceipts(getPrisma(), (await getDashboardWorkspaceId()), filters.data); } catch { /* Render a failure state, never an empty success. */ }
  return <main className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-[96rem] space-y-5">
    <header><h1 className="text-xl font-semibold">Accepted webhooks</h1><p className="mt-1 text-xs text-st-muted">Environment · {filters.data.environment ?? "All environments"}</p>
      <p className="mt-3 text-sm text-st-muted">Stored webhook receipts and asynchronous body checks. Separate from the 4xx incident queue.</p></header>
    <WebhookViews filters={filters.data} active="receipts" /><WebhookAcceptanceNote />
    <div className="flex flex-wrap items-end justify-between gap-4">
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-st-muted">Service<input name="svc" defaultValue={filters.data.service ?? ""} placeholder="All services" className={`mt-1 block min-h-11 w-56 max-w-full rounded-md border border-st-muted/70 bg-base-200 px-3 text-sm text-base-content ${focusRing}`} /></label>
        <label className="text-xs text-st-muted">Environment<input name="env" defaultValue={filters.data.environment ?? ""} placeholder="All environments" className={`mt-1 block min-h-11 w-48 max-w-full rounded-md border border-st-muted/70 bg-base-200 px-3 text-sm text-base-content ${focusRing}`} /></label>
        <button type="submit" className={secondaryAction}>Apply filters</button>
      </form>
      <WebhookRefresh watch={Boolean(result?.rows.some((row) => row.state === "Pending"))} />
    </div>
    {result ? <WebhookReceiptList rows={result.rows} total={result.total} filters={filters.data} /> : <section className={`${panel} p-6`} role="status"><h2 className="font-medium">Receipts could not be loaded</h2><p className="mt-2 text-sm text-st-muted">The receipt store is unavailable. Refresh to try again; this does not mean there are no accepted webhooks.</p></section>}
  </div></main>;
}
export default function AcceptedWebhooksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return <DashboardFrame><Suspense fallback={<main className="p-6" aria-busy="true">Loading accepted webhooks.</main>}><WebhooksBody searchParams={searchParams} /></Suspense></DashboardFrame>;
}
