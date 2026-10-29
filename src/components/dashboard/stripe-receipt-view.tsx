import Link from "next/link";
import type { ReactNode } from "react";
import { panel, secondaryAction } from "@/components/dashboard/styles";
import { WebhookState } from "@/components/dashboard/webhook-receipt-view";
import { stripeReceiptHref, type StripeReceiptFilters } from "@/lib/dashboard/stripe-receipts";
import type { StripeReceiptDetail, StripeReceiptSummary } from "@/server/dashboard/stripe-receipts";

export function StripeAcceptanceNote() {
  return <p className="max-w-4xl border-l-2 border-accent pl-3 text-sm leading-relaxed">Accepted for asynchronous checks. Business processing is not confirmed. Stripe test receipts retain selected field shapes only, with all payload values omitted.</p>;
}
function utc(value: string) { return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"); }
function Fact({ title, children }: { title: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-st-muted">{title}</dt><dd className="mt-1 break-words text-sm">{children}</dd></div>;
}
export function StripeScopeNotice({ filters }: { filters: StripeReceiptFilters }) {
  return <section className={`${panel} p-6`} role="status"><h2 className="font-medium">Service and environment are not recorded for Stripe receipts</h2>
    <p className="mt-2 max-w-3xl text-sm text-st-muted">The selected service or environment cannot be applied to this view. No unfiltered receipts are shown. Test mode describes the Stripe event, not a deployment environment.</p>
    <Link className={`mt-4 ${secondaryAction}`} href={stripeReceiptHref({ page: 1, integrationId: filters.integrationId })}>View without service/environment scope</Link>
  </section>;
}
export function StripeReceiptList({ rows, total, filters }: { rows: StripeReceiptSummary[]; total: number; filters: StripeReceiptFilters }) {
  const pages = Math.max(1, Math.ceil(total / 20));
  return <section className={panel} aria-label="Stored Stripe test receipts">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-300 px-4 py-3 sm:px-6"><h2 className="text-sm font-medium">Stored Stripe test receipts</h2><p className="text-xs text-st-muted">{rows.length ? `${(filters.page - 1) * 20 + 1}–${(filters.page - 1) * 20 + rows.length} of ${total}` : total} receipts</p></div>
    {!rows.length ? <div className="p-6"><h3 className="font-medium">{total ? "No Stripe receipts on this page" : "No Stripe test receipts in this scope"}</h3>
      <p className="mt-2 max-w-3xl text-sm text-st-muted">{total ? "Return to an earlier page." : "Receipts appear after the local Stripe test receiver commits a protected shape and work item. This view does not connect or enable a Stripe account."}</p></div> : <>
      <div className="hidden xl:block"><table className="w-full table-fixed text-left text-sm"><colgroup><col className="w-[32%]" /><col className="w-[23%]" /><col className="w-[20%]" /><col className="w-[12%]" /><col className="w-[13%]" /></colgroup>
        <thead className="text-xs text-st-muted"><tr>{["Event / type", "Accepted at", "Configured integration", "Checks", "Review"].map(label => <th key={label} className="px-4 py-3 font-medium first:pl-6">{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} className="border-t border-base-300 align-top">
          <td className="break-all px-4 py-3 pl-6"><p className="font-mono text-xs">{row.eventId ?? "Event reference unavailable"}</p><p className="mt-2 font-mono text-sm">{row.eventType ?? "Event type unavailable"}</p></td>
          <td className="break-words px-4 py-3 font-mono text-xs leading-relaxed"><time dateTime={row.receivedAt}>{utc(row.receivedAt)}</time></td>
          <td className="break-all px-4 py-3 font-mono text-xs leading-relaxed">{row.integrationId}</td>
          <td className="px-4 py-3"><WebhookState state={row.state} /></td>
          <td className="px-4 py-2"><Link className={secondaryAction} href={stripeReceiptHref(filters, row.id)} aria-label={`View Stripe receipt ${row.id.slice(0, 8)}`}>View receipt</Link></td>
        </tr>)}</tbody></table></div>
      <ul className="divide-y divide-base-300 xl:hidden">{rows.map(row => <li key={row.id} className="min-w-0 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><p className="min-w-0 break-all font-mono text-xs">{row.eventId ?? "Event reference unavailable"}</p><WebhookState state={row.state} /></div>
        <p className="mt-2 break-all font-mono text-sm">{row.eventType ?? "Event type unavailable"}</p>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2"><Fact title="Accepted at"><time dateTime={row.receivedAt}>{utc(row.receivedAt)}</time></Fact><Fact title="Configured integration"><span className="break-all font-mono text-xs">{row.integrationId}</span></Fact></dl>
        <Link className={`mt-4 ${secondaryAction}`} href={stripeReceiptHref(filters, row.id)} aria-label={`View Stripe receipt ${row.id.slice(0, 8)}`}>View receipt</Link>
      </li>)}</ul>
    </>}
    {pages > 1 ? <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-base-300 px-4 py-3 sm:px-6" aria-label="Stripe receipt pages"><p className="text-xs text-st-muted">Page {filters.page} of {pages}</p><div className="flex gap-2">
      {filters.page > 1 ? <Link className={secondaryAction} href={stripeReceiptHref({ ...filters, page: filters.page - 1 })}>Previous</Link> : null}
      {filters.page < pages ? <Link className={secondaryAction} href={stripeReceiptHref({ ...filters, page: filters.page + 1 })}>Next</Link> : null}
    </div></nav> : null}
  </section>;
}
export function StripeReceiptInspection({ receipt }: { receipt: StripeReceiptDetail }) {
  return <div className="space-y-4">
    <section className={`${panel} p-4 sm:p-6`} aria-labelledby="stripe-acceptance">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="stripe-acceptance" className="font-medium">Acceptance record · test mode</h2><WebhookState state={receipt.state} /></div>
      <p className="mt-3 break-all font-mono text-sm">{receipt.eventId ?? "Event reference unavailable"}</p><p className="mt-2 break-all font-mono text-sm">{receipt.eventType ?? "Event type unavailable"}</p>
      <dl className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <Fact title="Accepted at"><time dateTime={receipt.receivedAt}>{utc(receipt.receivedAt)}</time></Fact>
        <Fact title="Event created at"><time dateTime={receipt.eventCreatedAt}>{utc(receipt.eventCreatedAt)}</time></Fact>
        <Fact title="Reported Stripe API version">{receipt.reportedApiVersion ?? "Not supplied or unavailable"}</Fact>
        <Fact title="Receipt ID"><span className="break-all font-mono text-xs">{receipt.id}</span></Fact>
        <Fact title="Configured integration"><span className="break-all font-mono text-xs">{receipt.integrationId}</span></Fact>
        <Fact title="Service / environment">Not recorded</Fact>
      </dl>
      <p className="mt-5 text-xs leading-relaxed text-st-muted">The event type and reported API version do not establish payment success, the correct contract revision or the version deployed.</p>
    </section>
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <section className={`${panel} min-w-0 p-4 sm:p-6`} aria-labelledby="stripe-shape"><h2 id="stripe-shape" className="font-medium">Protected field shapes</h2>
        <p className="mt-2 text-sm leading-relaxed text-st-muted">All payload values are omitted. These selected observations cannot reconstruct or replay the original payload.</p>
        {receipt.fields ? <dl className="mt-5 divide-y divide-base-300">{receipt.fields.map(field => <div key={field.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 py-3 first:pt-0">
          <dt className="font-mono text-sm">/{field.name}</dt><dd className="text-right text-sm">{field.presence === "missing" ? "Missing" : `Present · ${field.jsonType}`}</dd>
        </div>)}</dl> : <p className="mt-4 text-sm">Protection format unavailable. Stored content is withheld.</p>}
        {receipt.protectionPolicy ? <p className="mt-4 break-all font-mono text-xs text-st-muted">Policy: {receipt.protectionPolicy}</p> : null}
        <p className="mt-4 text-xs leading-relaxed text-st-muted">Changes to omitted values cannot be detected from these shapes. No full-schema or value-level validation is represented here.</p>
      </section>
      <section className={`${panel} min-w-0 p-4 sm:p-6`} aria-labelledby="stripe-checks"><h2 id="stripe-checks" className="font-medium">Contract not configured</h2>
        <p className="mt-2 text-sm leading-relaxed text-st-muted">{receipt.state === "Pending" ? "The structural check is queued. A contract check cannot pass until a supported contract is explicitly configured." : receipt.state === "Failed" ? "The structural check did not complete. An operator needs to review the job; stored acceptance remains recorded." : receipt.checkReason === "STRIPE_CONTRACT_NOT_CONFIGURED" ? "Checks are incomplete. The worker recorded that no Stripe contract is configured." : receipt.checkReason === "STRIPE_PROTECTION_UNAVAILABLE" ? "Checks are incomplete because the stored protection format is unsupported." : "Conclusive validation evidence is unavailable. No passing contract check is asserted."}</p>
        <p className="mt-4 text-sm">Schema checks and signature verification do not establish backend or business correctness.</p>
        {receipt.checkedAt ? <p className="mt-4 text-xs text-st-muted">Structural check recorded at {utc(receipt.checkedAt)}</p> : null}
      </section>
    </div>
    <section className={`${panel} p-4 sm:p-6`} aria-labelledby="stripe-verification"><h2 id="stripe-verification" className="font-medium">{receipt.verification ? "Configured signing secret verified" : "Verification metadata unavailable"}</h2>
      <p className="mt-2 max-w-4xl text-sm leading-relaxed text-st-muted">{receipt.verification ? "The stored metadata records verification of the original bytes using a configured endpoint secret. This establishes secret possession, not independent verification of a Stripe account, customer identity or business processing." : "Stored verification metadata is unsupported or inconsistent with this receipt. No verified-signature claim is shown."}</p>
      {receipt.verification ? <dl className="mt-4 grid gap-4 sm:grid-cols-2"><Fact title="Verified at">{utc(receipt.verification.verifiedAt)}</Fact><Fact title="Signature timestamp">{utc(receipt.verification.signedAt)}</Fact></dl> : null}
    </section>
  </div>;
}
