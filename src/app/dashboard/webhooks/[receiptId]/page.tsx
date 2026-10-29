import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { secondaryAction, panel } from "@/components/dashboard/styles";
import { WebhookAcceptanceNote, WebhookReceiptInspection } from "@/components/dashboard/webhook-receipt-view";
import { WebhookRefresh } from "@/components/dashboard/webhook-refresh";
import { parseWebhookFilters, webhookHref } from "@/lib/dashboard/webhook-receipts";
import { getPrisma } from "@/lib/db";

import { loadWebhookReceipt } from "@/server/dashboard/webhook-receipts";

export const metadata: Metadata = { title: "Webhook receipt · SpekTrace", robots: { index: false, follow: false } };
type Props = { params: Promise<{ receiptId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
async function ReceiptBody({ params, searchParams }: Props) {
  await connection();
  const [route, raw] = await Promise.all([params, searchParams]); const parsed = parseWebhookFilters(raw);
  const filters = parsed.success ? parsed.data : { page: 1 };
  let receipt: Awaited<ReturnType<typeof loadWebhookReceipt>> = null; let failed = false;
  if (parsed.success) {
    try { receipt = await loadWebhookReceipt(getPrisma(), (await getDashboardWorkspaceId()), route.receiptId, filters); } catch { failed = true; }
  }
  return <main className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-[96rem] space-y-5">
    <header><h1 className="text-xl font-semibold">Webhook receipt</h1><p className="mt-1 text-xs text-st-muted">Environment · {filters.environment ?? "All environments"}</p></header>
    <WebhookAcceptanceNote />
    <div className="flex flex-wrap items-center justify-between gap-3"><Link className={secondaryAction} href={webhookHref(filters)}>Back to accepted webhooks</Link><WebhookRefresh watch={receipt?.state === "Pending"} /></div>
    {receipt ? <WebhookReceiptInspection receipt={receipt} filters={filters} /> : <section className={`${panel} p-6`} role="status"><h2 className="font-medium">{failed ? "Receipt could not be loaded" : !parsed.success ? "Invalid receipt filters" : "Receipt unavailable in this scope"}</h2>
      <p className="mt-2 text-sm text-st-muted">{failed ? "The receipt store is unavailable. Refresh to try again." : "Return to the receipt list and check the selected service and environment."}</p></section>}
  </div></main>;
}
export default function WebhookReceiptPage(props: Props) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return <DashboardFrame><Suspense fallback={<main className="p-6" aria-busy="true">Loading webhook receipt.</main>}><ReceiptBody {...props} /></Suspense></DashboardFrame>;
}
