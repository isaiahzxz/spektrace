import Link from "next/link";
import { panel, secondaryAction, focusRing } from "@/components/dashboard/styles";
import { stripeReceiptHref } from "@/lib/dashboard/stripe-receipts";
import { webhookHref, type WebhookFilters } from "@/lib/dashboard/webhook-receipts";
import { webhookGroupHref } from "@/lib/dashboard/webhook-groups";
import type { WebhookGroupSummary, WebhookGroupDetail } from "@/server/dashboard/webhook-groups";
import { WebhookReceiptList } from "@/components/dashboard/webhook-receipt-view";

const utc = (value: string) => value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
export function WebhookViews({ filters, active }: { filters: WebhookFilters; active: "receipts" | "groups" | "stripe" }) {
  return <nav aria-label="Webhook views" className="flex flex-wrap gap-2">
    {[{ id: "receipts", label: "Receipts", href: webhookHref({ ...filters, page: 1 }) },
      { id: "groups", label: "Drift groups", href: webhookGroupHref({ ...filters, page: 1 }) },
      { id: "stripe", label: "Stripe receipts", href: stripeReceiptHref({ ...filters, page: 1 }) }].map((item) =>
      <Link key={item.id} href={item.href} aria-current={item.id === active ? "page" : undefined}
        className={`${secondaryAction} ${item.id === active ? "border-2 border-current font-semibold" : ""}`}>{item.label}</Link>)}
  </nav>;
}
export function GroupingNote() {
  return <p className="max-w-4xl border-l-2 border-accent pl-3 text-sm leading-relaxed">Synthetic signing-key verification only. Groups relate stored mismatches; they do not establish a shared root cause, real-provider identity or business failure.</p>;
}
export function WebhookGroupList({ rows, total, filters }: { rows: WebhookGroupSummary[]; total: number; filters: WebhookFilters }) {
  const pages = Math.max(1, Math.ceil(total / 20));
  return <section className={panel} aria-label="Webhook drift groups">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-300 p-4 sm:px-6"><h2 className="font-medium">Stored drift groups</h2><span className="text-xs text-st-muted">{total} {total === 1 ? "group" : "groups"}</span></div>
    {!rows.length ? <div className="p-6"><h3 className="font-medium">{total ? "No groups on this page" : "No drift groups in this scope"}</h3>
      <p className="mt-2 text-sm text-st-muted">{total ? "Return to an earlier page." : "Only eligible, newly validated signed mismatches create groups. Passing, incomplete and unsigned receipts remain in Receipts."}</p></div> :
      <ul className="divide-y divide-base-300">{rows.map((row) => <li key={row.id} className="grid items-start gap-4 p-4 sm:px-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]">
        <div className="min-w-0"><h3 className="break-all font-mono text-sm">{row.method} {row.operationPath}</h3><p className="mt-1 break-all text-xs text-st-muted">{row.service} · {row.environment}</p>
          <p className="mt-2 text-sm">{row.count} {row.count === 1 ? "receipt" : "receipts"}</p></div>
        <dl className="min-w-0 text-sm"><dt className="text-xs text-st-muted">Configured sender</dt><dd className="mt-1 break-words">{row.senderLabel}</dd>
          <dt className="mt-3 text-xs text-st-muted">Pinned revision</dt><dd className="mt-1 break-words">{row.specLabel}</dd></dl>
        <div className="min-w-0"><p className="text-xs text-st-muted">Received window · start inclusive, end exclusive</p><p className="mt-1 break-words font-mono text-xs leading-relaxed">{utc(row.windowStart)}<br />to {utc(row.windowEnd)}</p>
          <p className="mt-2 font-mono text-xs text-st-muted">Group {row.id.slice(0, 8)}</p></div>
        <Link className={secondaryAction} href={webhookGroupHref(filters, row.id)} aria-label={`Open group ${row.id.slice(0, 8)}`}>Open group</Link>
      </li>)}</ul>}
    {pages > 1 ? <nav aria-label="Group pages" className="flex flex-wrap items-center justify-between gap-3 border-t border-base-300 p-4 sm:px-6"><p className="text-xs text-st-muted">Page {filters.page} of {pages}</p><div className="flex gap-2">
      {filters.page > 1 ? <Link className={secondaryAction} href={webhookGroupHref({ ...filters, page: filters.page - 1 })}>Previous</Link> : null}
      {filters.page < pages ? <Link className={secondaryAction} href={webhookGroupHref({ ...filters, page: filters.page + 1 })}>Next</Link> : null}</div></nav> : null}
  </section>;
}
export function WebhookGroupInspection({ detail, filters }: { detail: WebhookGroupDetail; filters: WebhookFilters }) {
  const { group, memberPage } = detail; const pages = Math.max(1, Math.ceil(group.count / 20));
  return <>
    <section className={`${panel} p-4 sm:p-6`} aria-labelledby="group-summary"><h2 id="group-summary" className="font-medium">{group.method} {group.operationPath}</h2>
      <p className="mt-2 break-all font-mono text-xs text-st-muted">Group {group.id}</p>
      <dl className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-xs text-st-muted">Configured sender</dt><dd className="mt-1 break-words text-sm">{group.senderLabel}</dd></div>
        <div><dt className="text-xs text-st-muted">Pinned revision</dt><dd className="mt-1 break-words text-sm">{group.specLabel}</dd></div>
        <div><dt className="text-xs text-st-muted">Service / environment</dt><dd className="mt-1 break-all text-sm">{group.service} · {group.environment}</dd></div>
        <div><dt className="text-xs text-st-muted">Grouped receipts</dt><dd className="mt-1 text-sm">{group.count}</dd></div>
      </dl>
      <p className="mt-5 text-sm text-st-muted">Received from {utc(group.windowStart)} up to, but excluding, {utc(group.windowEnd)}. The revision was pinned at acceptance; runtime deployment is unverified.</p>
      <details className="mt-3 text-sm"><summary className={`inline-flex min-h-11 cursor-pointer items-center ${focusRing}`}>Grouping identifiers</summary>
        <p className="mt-2 break-all font-mono text-xs">Sender: {group.senderId}</p><p className="mt-2 break-all font-mono text-xs">Revision: {group.specId}</p>
        <p className="mt-2 break-all font-mono text-xs">Specification SHA-256: {group.sourceSha256}</p><p className="mt-2 break-all font-mono text-xs">Structural fingerprint: {group.driftFingerprint}</p></details>
    </section>
    <div><h2 className="mb-2 font-medium">Member receipts</h2><p className="mb-4 text-sm text-st-muted">Open a receipt for its protected payload and expected-versus-received evidence.</p>
      <WebhookReceiptList rows={detail.receipts} total={group.count} filters={{ ...filters, page: memberPage }} paginate={false} />
      {pages > 1 ? <nav aria-label="Member pages" className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-st-muted">Receipt page {memberPage} of {pages} · {group.count} total</p><div className="flex gap-2">
        {memberPage > 1 ? <Link className={secondaryAction} href={webhookGroupHref(filters, group.id, memberPage - 1)}>Previous receipts</Link> : null}
        {memberPage < pages ? <Link className={secondaryAction} href={webhookGroupHref(filters, group.id, memberPage + 1)}>Next receipts</Link> : null}</div></nav> : null}
    </div>
  </>;
}
