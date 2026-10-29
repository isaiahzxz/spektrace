import Link from "next/link";
import type { ReactNode } from "react";
import { focusRing, inset, panel, secondaryAction } from "@/components/dashboard/styles";
import { webhookHref, type WebhookDisplayState, type WebhookFilters } from "@/lib/dashboard/webhook-receipts";
import type { WebhookReceiptDetail, WebhookReceiptSummary } from "@/server/dashboard/webhook-receipts";
import { webhookGroupHref } from "@/lib/dashboard/webhook-groups";

export const WEBHOOK_ACCEPTANCE_NOTE = "Accepted for validation. Business processing is not confirmed.";
const descriptions: Record<WebhookDisplayState, string> = {
  Pending: "The stored receipt is waiting for asynchronous validation.",
  Passed: "The supported request-body schema matched. This does not establish backend or business correctness.",
  Mismatch: "The stored sanitized payload did not match its pinned request-body schema.",
  Incomplete: "A conclusive body check is unavailable. Review the protection notice and pinned revision.",
  Failed: "Validation could not complete. An operator needs to review the validation job; acceptance is still recorded.",
};
function utc(value: string) { return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"); }
export function WebhookState({ state }: { state: WebhookDisplayState }) {
  const tone = state === "Mismatch" || state === "Failed" ? "text-error" : "text-base-content";
  return <span className={`inline-flex items-center gap-2 text-sm font-medium ${tone}`}><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />{state}</span>;
}
export function WebhookAcceptanceNote() {
  return <p className="border-l-2 border-accent pl-3 text-sm leading-relaxed">{WEBHOOK_ACCEPTANCE_NOTE}</p>;
}
export function WebhookReceiptList({ rows, total, filters, paginate = true }: { rows: WebhookReceiptSummary[]; total: number; filters: WebhookFilters; paginate?: boolean }) {
  const pages = Math.max(1, Math.ceil(total / 20));
  return <section aria-label="Accepted webhook receipts" className={panel}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-300 px-4 py-3 sm:px-6">
      <h2 className="text-sm font-medium">Stored receipts</h2>
      <p className="text-xs text-st-muted">{rows.length ? `${(filters.page - 1) * 20 + 1}–${(filters.page - 1) * 20 + rows.length} of ${total}` : `${total}`} receipts</p>
    </div>
    {!rows.length ? <div className="p-6"><p className="font-medium">{total ? "No receipts on this page" : "No accepted webhooks in this scope"}</p>
      <p className="mt-2 max-w-2xl text-sm text-st-muted">{total ? "Return to an earlier page to review stored receipts." : "Receipts appear after the synthetic webhook endpoint commits a sanitized payload and validation job. Existing 4xx incidents remain in Incidents."}</p></div> : <>
      <div className="hidden lg:block"><table className="w-full table-fixed text-left text-sm"><colgroup><col className="w-[30%]" /><col className="w-[20%]" /><col className="w-[25%]" /><col className="w-[12%]" /><col className="w-[13%]" /></colgroup>
        <thead className="text-xs text-st-muted"><tr>{["Receipt / endpoint", "Accepted at", "Pinned revision", "Validation", "Review"].map((label) => <th key={label} className="px-4 py-3 font-medium first:pl-6">{label}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id} className="border-t border-base-300 align-top">
          <td className="px-4 py-3 pl-6"><p className="font-mono text-xs">{row.id.slice(0, 8)}</p><p className="mt-1 break-all font-mono text-sm">POST {row.operationPath}</p><p className="mt-1 break-all text-xs text-st-muted">{row.service} · {row.environment}</p></td>
          <td className="break-words px-4 py-3 font-mono text-xs leading-relaxed"><time dateTime={row.receivedAt}>{utc(row.receivedAt)}</time></td>
          <td className="break-words px-4 py-3 text-sm">{row.specLabel}</td><td className="px-4 py-3"><WebhookState state={row.state} /></td>
          <td className="px-4 py-2"><Link className={secondaryAction} href={webhookHref(filters, row.id)} aria-label={`View receipt ${row.id.slice(0, 8)}`}>View receipt</Link></td>
        </tr>)}</tbody>
      </table></div>
      <ul className="divide-y divide-base-300 lg:hidden">{rows.map((row) => <li key={row.id} className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs">{row.id.slice(0, 8)}</span><WebhookState state={row.state} /></div>
        <p className="mt-2 break-all font-mono text-sm">POST {row.operationPath}</p><p className="mt-1 break-all text-xs text-st-muted">{row.service} · {row.environment}</p>
        <dl className="mt-3 space-y-2 text-sm"><div><dt className="text-xs text-st-muted">Accepted at</dt><dd className="mt-1 break-words font-mono text-xs"><time dateTime={row.receivedAt}>{utc(row.receivedAt)}</time></dd></div>
          <div><dt className="text-xs text-st-muted">Pinned revision</dt><dd className="mt-1 break-words">{row.specLabel}</dd></div></dl>
        <Link className={`mt-3 ${secondaryAction}`} href={webhookHref(filters, row.id)} aria-label={`View receipt ${row.id.slice(0, 8)}`}>View receipt</Link>
      </li>)}</ul>
    </>}
    {pages > 1 && paginate ? <nav aria-label="Receipt pages" className="flex flex-wrap items-center justify-between gap-3 border-t border-base-300 px-4 py-3 sm:px-6">
      <p className="text-xs text-st-muted">Page {filters.page} of {pages}</p><div className="flex gap-2">{filters.page > 1 ? <Link className={secondaryAction} href={webhookHref({ ...filters, page: filters.page - 1 })}>Previous</Link> : null}
        {filters.page < pages ? <Link className={secondaryAction} href={webhookHref({ ...filters, page: filters.page + 1 })}>Next</Link> : null}</div>
    </nav> : null}
  </section>;
}
function ReceiptFact({ title, children }: { title: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-st-muted">{title}</dt><dd className="mt-1 break-words text-sm">{children}</dd></div>;
}
export function WebhookReceiptInspection({ receipt, filters = { page: 1 } }: { receipt: WebhookReceiptDetail; filters?: WebhookFilters }) {
  return <div className="space-y-4">
    <section className={`${panel} p-4 sm:p-6`} aria-labelledby="receipt-summary">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="receipt-summary" className="font-medium">Acceptance record</h2><WebhookState state={receipt.state} /></div>
      <p className="mt-2 break-all font-mono text-xs">{receipt.id}</p>
      <dl className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <ReceiptFact title="Accepted at"><time dateTime={receipt.receivedAt}>{utc(receipt.receivedAt)}</time></ReceiptFact>
        <ReceiptFact title="Endpoint"><span className="font-mono">POST {receipt.operationPath}</span></ReceiptFact>
        <ReceiptFact title="Service / environment">{receipt.service} · {receipt.environment}</ReceiptFact>
        <ReceiptFact title="Pinned revision">{receipt.specLabel}</ReceiptFact>
        <ReceiptFact title="Body check completed">{receipt.validatedAt ? utc(receipt.validatedAt) : "Not completed"}</ReceiptFact>
        <ReceiptFact title="Revision selection">{receipt.selectionLabel}</ReceiptFact>
        <ReceiptFact title="Sender verification">{receipt.verificationLabel}</ReceiptFact>
      </dl>
      {receipt.senderVerification ? <div className="mt-5 text-sm">
        <p>SpekTrace verified possession of the configured signing key for the original request bytes. This synthetic protocol does not verify a real provider or business processing.</p>
        <p className="mt-2 break-all font-mono text-xs text-st-muted">Sender: {receipt.senderVerification.senderId}</p>
        <p className="mt-2 text-xs text-st-muted">Verified at {utc(receipt.senderVerification.verifiedAt)}</p>
      </div> : null}
      <div className="mt-5 border-t border-base-300 pt-4">
        <h3 className="text-sm font-medium">Drift grouping</h3>
        <p className="mt-2 text-sm">{receipt.groupingLabel}</p>
        {receipt.driftGroup ? <>
          <p className="mt-2 text-sm">{receipt.driftGroup.count} {receipt.driftGroup.count === 1 ? "receipt" : "receipts"} with the same sender, structural mismatch and pinned revision.</p>
          <p className="mt-2 break-all font-mono text-xs text-st-muted">Group: {receipt.driftGroup.id}</p>
          <Link className={`mt-3 ${secondaryAction}`} href={webhookGroupHref({ ...filters, page: 1 }, receipt.driftGroup.id)}>Open drift group</Link>
          <p className="mt-2 text-xs text-st-muted">Received from {utc(receipt.driftGroup.windowStart)} up to, but excluding, {utc(receipt.driftGroup.windowEnd)}.</p>
          <p className="mt-2 text-xs text-st-muted">Related stored mismatches do not establish a shared root cause or business failure.</p>
        </> : null}
      </div>
      {receipt.specId ? <details className="mt-5 text-sm"><summary className={`cursor-pointer py-2 ${focusRing}`}>Revision identifiers</summary><p className="mt-2 break-all font-mono text-xs">Revision: {receipt.specId}</p><p className="mt-2 break-all font-mono text-xs">SHA-256: {receipt.sourceSha256 ?? "Unavailable"}</p></details> : null}
    </section>
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <section className={`${panel} min-w-0 p-4 sm:p-6`} aria-labelledby="receipt-payload"><h2 id="receipt-payload" className="font-medium">Stored sanitized payload</h2>
        <p className="mt-2 text-sm text-st-muted">This is the retained projection. Omitted original values cannot be recovered here.</p>
        {receipt.payload !== null ? <pre tabIndex={0} aria-label="Stored sanitized payload JSON" className={`mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-sm ${inset} ${focusRing}`}>{receipt.payload}</pre> : <p className="mt-4 text-sm">The stored payload is outside this view’s supported protection format and is not displayed.</p>}
        <h3 className="mt-5 text-sm font-medium">Protection notice</h3>
        <p className="mt-2 text-sm text-st-muted">{receipt.omissions === null ? "Protection metadata is unavailable. Completeness is unknown." : receipt.omissions.length ? `Omitted fields: ${receipt.omissions.join(", ")}. The original body cannot be conclusively validated.` : "No fields were omitted by the synthetic fixture policy. This is not a general PII-safety guarantee."}</p>
        {receipt.policy ? <p className="mt-2 font-mono text-xs text-st-muted">Policy: {receipt.policy}</p> : null}
      </section>
      <section className={`${panel} min-w-0 p-4 sm:p-6`} aria-labelledby="receipt-validation"><h2 id="receipt-validation" className="font-medium">Request-body validation</h2>
        <p className="mt-2 text-sm leading-relaxed text-st-muted">{descriptions[receipt.state]}</p>
        {receipt.integrityNote ? <p className="mt-3 text-sm text-st-muted">{receipt.integrityNote}</p> : null}
        {receipt.reasonCode ? <p className="mt-3 break-all font-mono text-xs text-st-muted">{receipt.reasonCode}</p> : null}
        {receipt.findings.length ? <ul className="mt-4 divide-y divide-base-300">{receipt.findings.map((finding, index) => <li key={index} className="py-3 first:pt-0">
          <p className="break-all font-mono text-sm">{finding.path}</p><p className="mt-1 break-words text-xs text-st-muted">Rule: {finding.rule}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm"><ReceiptFact title="Expected">{finding.expected ?? (finding.missingProperty ? `Required field ${finding.missingProperty}` : "See pinned schema")}</ReceiptFact>
            <ReceiptFact title="Received">{finding.missingProperty ? "Missing" : finding.received ?? "Field unavailable"}</ReceiptFact></dl>
        </li>)}</ul> : <p className="mt-4 text-sm text-st-muted">{receipt.state === "Passed" ? "No mismatch findings in the supported body check." : "No field-level findings are available."}</p>}
      </section>
    </div>
  </div>;
}
