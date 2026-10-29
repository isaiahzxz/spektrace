import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { panel, secondaryAction } from "@/components/dashboard/styles";
import { GroupingNote, WebhookViews, WebhookGroupInspection } from "@/components/dashboard/webhook-groups-view";
import { WebhookRefresh } from "@/components/dashboard/webhook-refresh";
import { parseWebhookFilters } from "@/lib/dashboard/webhook-receipts";
import { parseMemberPage, webhookGroupHref } from "@/lib/dashboard/webhook-groups";
import { getPrisma } from "@/lib/db";

import { loadWebhookGroup } from "@/server/dashboard/webhook-groups";

export const metadata: Metadata = { title: "Webhook drift group · SpekTrace", robots: { index: false, follow: false } };
type Props = { params: Promise<{ groupId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
async function GroupBody({ params, searchParams }: Props) {
  await connection(); const [route, raw] = await Promise.all([params, searchParams]);
  const parsed = parseWebhookFilters(raw); const members = parseMemberPage(raw.members); const filters = parsed.success ? parsed.data : { page: 1 };
  let detail: Awaited<ReturnType<typeof loadWebhookGroup>> = null; let failed = false;
  if (parsed.success && members.success) { try { detail = await loadWebhookGroup(getPrisma(), (await getDashboardWorkspaceId()), route.groupId, filters, members.data); } catch { failed = true; } }
  return <main className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-[96rem] space-y-5">
    <header><h1 className="text-xl font-semibold">Webhook drift group</h1><p className="mt-1 text-xs text-st-muted">Environment · {filters.environment ?? "All environments"}</p></header>
    <WebhookViews filters={filters} active="groups" /><GroupingNote />
    <div className="flex flex-wrap items-center justify-between gap-3"><Link href={webhookGroupHref(filters)} className={secondaryAction}>Back to drift groups</Link><WebhookRefresh watch={false} subject="groups" /></div>
    {detail ? <WebhookGroupInspection detail={detail} filters={filters} /> : <section className={`${panel} p-6`} role="status"><h2 className="font-medium">{failed ? "Group could not be loaded" : !parsed.success || !members.success ? "Invalid group filters" : "Group unavailable in this scope"}</h2>
      <p className="mt-2 text-sm text-st-muted">{failed ? "The group store is unavailable. Refresh to try again." : "Return to the group list and check the selected service and environment."}</p></section>}
  </div></main>;
}
export default function WebhookGroupPage(props: Props) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return <DashboardFrame><Suspense fallback={<main className="p-6" aria-busy="true">Loading webhook drift group.</main>}><GroupBody {...props} /></Suspense></DashboardFrame>;
}
