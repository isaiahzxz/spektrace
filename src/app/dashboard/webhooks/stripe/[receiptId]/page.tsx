import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { WebhookViews } from "@/components/dashboard/webhook-groups-view";
import { StripeAcceptanceNote, StripeReceiptInspection, StripeScopeNotice } from "@/components/dashboard/stripe-receipt-view";
import { WebhookRefresh } from "@/components/dashboard/webhook-refresh";
import { panel, secondaryAction } from "@/components/dashboard/styles";
import { parseStripeReceiptFilters, stripeReceiptHref, stripeScopeUnsupported } from "@/lib/dashboard/stripe-receipts";
import { getPrisma } from "@/lib/db";

import { loadStripeReceipt } from "@/server/dashboard/stripe-receipts";

export const metadata: Metadata = { title: "Stripe receipt · SpekTrace", robots: { index: false, follow: false } };
type Props = { params: Promise<{ receiptId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
async function StripeReceiptBody({ params, searchParams }: Props) {
  await connection();
  const [route, raw] = await Promise.all([params, searchParams]); const parsed = parseStripeReceiptFilters(raw);
  const filters = parsed.success ? parsed.data : { page: 1 };
  let receipt: Awaited<ReturnType<typeof loadStripeReceipt>> = null, failed = false;
  if (parsed.success && !stripeScopeUnsupported(filters)) {
    try { receipt = await loadStripeReceipt(getPrisma(), (await getDashboardWorkspaceId()), route.receiptId, filters); } catch { failed = true; }
  }
  return <main className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-[96rem] space-y-5">
    <header><h1 className="text-xl font-semibold">Stripe test receipt</h1><p className="mt-2 text-sm text-st-muted">Read-only · all payload values omitted</p></header>
    <WebhookViews filters={filters} active="stripe" /><StripeAcceptanceNote />
    <div className="flex flex-wrap items-center justify-between gap-3"><Link className={secondaryAction} href={stripeReceiptHref(filters)}>Back to Stripe receipts</Link><WebhookRefresh watch={receipt?.state === "Pending"} /></div>
    {stripeScopeUnsupported(filters) ? <StripeScopeNotice filters={filters} /> : receipt ? <StripeReceiptInspection receipt={receipt} /> : <section className={`${panel} p-6`} role="status"><h2 className="font-medium">{failed ? "Stripe receipt could not be loaded" : !parsed.success ? "Invalid receipt filters" : "Stripe receipt unavailable in this scope"}</h2><p className="mt-2 text-sm text-st-muted">{failed ? "The receipt store is unavailable. Refresh to try again." : "Return to the receipt list and check the configured integration filter."}</p></section>}
  </div></main>;
}
export default function StripeReceiptPage(props: Props) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return <DashboardFrame><Suspense fallback={<main className="p-6" aria-busy="true">Loading Stripe receipt.</main>}><StripeReceiptBody {...props} /></Suspense></DashboardFrame>;
}
