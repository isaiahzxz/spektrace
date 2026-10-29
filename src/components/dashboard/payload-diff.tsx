import * as React from "react";
import { buildPayloadDiff } from "@/lib/payload-proposal/payload-diff";
import { focusRing, inset } from "./styles";

export function PayloadDiff({ originalText, candidateText, title = "Changes from stored request" }: { originalText: string; candidateText: string; title?: string }) {
  const headingId = React.useId();
  const diff = React.useMemo(() => buildPayloadDiff(originalText, candidateText), [originalText, candidateText]);
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <h4 id={headingId} className="text-sm font-medium">{title}</h4>
      {diff.status === "unchanged" ? <p className="mt-1 text-sm text-st-muted">No changes from the stored request.</p> : diff.status === "limited" ? (
        <>
          <p className="mt-1 text-sm text-st-muted">Inline diff is unavailable for this payload size. Compare the stored original below with the candidate editor.</p>
          <pre tabIndex={0} aria-label="Original payload, stored" className={`mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed ${inset} ${focusRing}`}>{originalText}</pre>
        </>
      ) : (
        <>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-st-muted"><span>− Original (stored)</span><span>+ Candidate</span></p>
          <pre tabIndex={0} aria-label="Original and candidate diff" className={`mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all py-2 font-mono text-xs leading-relaxed ${inset} ${focusRing}`}>
            {diff.rows.map((row, index) => <span key={index} className={`block px-3 ${row.kind === "removed" ? "bg-error/10" : row.kind === "added" ? "bg-success/10" : ""}`}><span aria-hidden="true">{row.kind === "removed" ? "−" : row.kind === "added" ? "+" : " "} </span><span className="sr-only">{row.kind === "removed" ? "Original: " : row.kind === "added" ? "Candidate: " : "Unchanged: "}</span>{row.text || "\u00a0"}</span>)}
          </pre>
        </>
      )}
    </section>
  );
}
