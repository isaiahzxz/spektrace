import Link from "next/link";
import { focusRing, panel, secondaryAction } from "./styles";
import {
  observationEmptyState,
  observationHref,
  type ObservationFilters,
} from "@/lib/dashboard/observation-query";
import type {
  listObservations,
  loadObservation,
} from "@/server/dashboard/integration-observations";
import { integrationHref } from "@/server/dashboard/integrations";
export const OBSERVATION_LABELS: Record<string, string> = {
  Pending: "Processing",
  PROCESSING_DELAYED: "Processing delayed",
  NO_RESPONSE: "No response",
  CAPTURE_OFF: "Shape capture off",
  INCOMPLETE: "Collection incomplete",
  NO_BASELINE: "No baseline selected",
  UNSUPPORTED: "Comparison unsupported",
  MATCH: "Selected fields match",
  ADDITION_ONLY: "Fields added",
  DRIFT: "Observed response drift",
  CONTRACT_MISMATCH: "Response contract mismatch",
  Incomplete: "Evidence incomplete",
};
const utc = (value: string) => value.replace("T", " ").replace("Z", " UTC");
export function ObservationNotice() {
  return (
    <p className="text-sm text-st-muted">
      Captured outbound calls, response changes and recorded outcomes.
    </p>
  );
}
export function ObservationList({
  data,
  filters,
}: {
  data: Awaited<ReturnType<typeof listObservations>>;
  filters: ObservationFilters;
}) {
  const totals = data.coverage.reduce(
    (sum, row) => {
      for (const key of Object.keys(sum) as (keyof typeof sum)[])
        sum[key] += row.counters[key];
      return sum;
    },
    {
      seen: 0,
      unsampled: 0,
      dropped: 0,
      deliveryUnconfirmed: 0,
      pending: 0,
      delivered: 0,
      bodyOmitted: 0,
    },
  );
  const empty = observationEmptyState(
    { ...data, coverageCount: data.coverage.length },
    filters,
  );
  const detailQuery = observationHref(filters).split("?")[1];
  return (
    <>
      <section
        className={`${panel} p-4 sm:p-5`}
        aria-labelledby="coverage-heading"
      >
        <h2 id="coverage-heading" className="font-medium">
          Capture coverage
        </h2>
        {data.coverage.length ? (
          <>
            <p className="mt-2 text-sm">
              {totals.seen} wrapper calls seen · {totals.delivered} delivery
              acknowledgments · {totals.unsampled} unsampled
            </p>
            {totals.dropped + totals.deliveryUnconfirmed + totals.pending >
            0 ? (
              <p className="mt-2 text-sm">
                {totals.dropped} dropped · {totals.deliveryUnconfirmed} delivery
                unconfirmed · {totals.pending} pending at report time
              </p>
            ) : null}
            <p className="mt-2 text-xs text-st-muted">
              Scope-wide reports, independent of the date/finding filters. Other
              application traffic is unknown.
            </p>
            <details className="mt-2 text-sm">
              <summary className={`min-h-11 cursor-pointer py-3 ${focusRing}`}>
                Collection details and report times
              </summary>
              <p className="leading-relaxed text-st-muted">
                Latest cumulative report per observer instance;{" "}
                {data.coverage.length} shown. Reports can be stale. Delivery
                acknowledgments can include deduplicated sends and are not
                unique-call counts. {totals.bodyOmitted} selected-shape
                collections omitted.
              </p>
              <ul className="mt-3 space-y-2">
                {data.coverage.map((row) => (
                  <li className="break-words text-xs" key={row.instanceId}>
                    {row.integration.key} / {row.integration.provider} /{" "}
                    {row.integration.environment} · sample{" "}
                    {row.sampleRate * 100}% · {utc(row.reportedAt)}
                  </li>
                ))}
              </ul>
              {data.coverageTruncated ? (
                <p className="mt-3">
                  Limited to 100 instances; coverage totals are partial.
                </p>
              ) : null}
              {data.coverageInvalid ? (
                <p className="mt-3">
                  {data.coverageInvalid} invalid reports withheld.
                </p>
              ) : null}
            </details>
          </>
        ) : (
          <p className="mt-2 text-sm text-st-muted">
            Coverage unknown. No capture report has been received for this
            scope.
          </p>
        )}
        <p className="mt-3 text-sm">
          {data.unmatched} outcomes currently unmatched in this integration
          scope.
        </p>
        {data.truncatedOutcomes > 0 ? (
          <p className="mt-2 text-sm">
            {data.truncatedOutcomes} outcomes reached the 100-call link limit;
            impact is incomplete.
          </p>
        ) : null}
      </section>
      <section className={panel}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <h2 className="font-medium">Captured calls</h2>
          <p className="text-xs text-st-muted">
            {data.total} matching calls · page {filters.page} of {data.pages}
          </p>
        </div>
        {data.rows.length ? (
          <ul className="divide-y divide-base-300">
            {data.rows.map((row) => (
              <li
                key={row.id}
                className="grid gap-3 p-4 lg:grid-cols-[minmax(10rem,1fr)_minmax(11rem,1fr)_minmax(12rem,1fr)_auto] lg:items-center"
              >
                <div>
                  <p className="font-medium">
                    {row.integration?.key ?? "Metadata withheld"}
                  </p>
                  <p className="mt-1 text-xs text-st-muted">
                    {row.integration?.provider} · {row.integration?.environment}
                  </p>
                </div>
                <div>
                  <p className="break-words font-mono text-xs">
                    {row.operation?.method} {row.operation?.path}
                  </p>
                  <p className="mt-1 text-xs text-st-muted">
                    {row.result?.kind === "HTTP"
                      ? `HTTP ${row.result.statusCode}`
                      : (row.result?.kind ?? "Result unknown")}{" "}
                    · {row.durationMs?.toFixed(1) ?? "Unknown"} ms to headers /
                    error
                  </p>
                </div>
                <div>
                  <p className="text-sm">
                    {OBSERVATION_LABELS[row.state] ?? "Evidence incomplete"}
                  </p>
                  <p className="mt-1 text-xs text-st-muted">
                    Received {utc(row.receivedAt)}
                  </p>
                </div>
                <Link
                  href={`/dashboard/observations/${row.id}${detailQuery ? "?" + detailQuery : ""}`}
                  className={secondaryAction}
                >
                  Investigate<span className="sr-only"> {row.id}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-5 sm:p-6">
            <h3 className="font-medium">
              {empty === "setup"
                ? "Connect an integration to see calls here"
                : empty === "waiting"
                  ? "Waiting for the first observation"
                  : empty === "page"
                    ? "No calls on this page"
                    : "No calls match these filters"}
            </h3>
            <p className="mt-2 max-w-2xl text-sm text-st-muted">
              {empty === "setup"
                ? "Configure the server-side observer, send a call through it, then flush delivery. There is no automatic connection or installable outbound SDK."
                : empty === "waiting"
                  ? "A baseline or capture report is recorded for this scope, but no call has been received. Check your observer and collector delivery; this is not a healthy-traffic verdict."
                  : empty === "page"
                    ? "Return to the first page of these results."
                    : "Change the integration, environment, received dates or finding filters. No matching records does not establish health."}
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {empty === "setup" || empty === "waiting" ? (
                <Link
                  href={
                    filters.svc
                      ? integrationHref(
                          filters.svc,
                          filters.provider,
                          filters.env,
                        ) + "#setup"
                      : "/dashboard/integrations#setup"
                  }
                  className={secondaryAction}
                >
                  Capture setup
                </Link>
              ) : (
                <Link
                  href={
                    empty === "page"
                      ? observationHref(filters, { page: 1 })
                      : "/dashboard/observations"
                  }
                  className={secondaryAction}
                >
                  {empty === "page" ? "First page" : "Clear filters"}
                </Link>
              )}
            </div>
          </div>
        )}
        <nav
          aria-label="Observation pages"
          className="flex gap-3 border-t border-base-300 p-4"
        >
          {filters.page > 1 ? (
            <Link
              href={observationHref(filters, { page: filters.page - 1 })}
              className={secondaryAction}
            >
              Previous
            </Link>
          ) : null}
          {filters.page < data.pages ? (
            <Link
              href={observationHref(filters, { page: filters.page + 1 })}
              className={secondaryAction}
            >
              Next
            </Link>
          ) : null}
        </nav>
      </section>
    </>
  );
}
export function ObservationDetail({
  data,
}: {
  data: NonNullable<Awaited<ReturnType<typeof loadObservation>>>;
}) {
  const event = data.event;
  return (
    <div className="space-y-5">
      <section className={`${panel} p-4 sm:p-6`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs text-st-muted">
              Deterministic structure check
            </p>
            <h2 className="mt-1 text-lg font-semibold">
              {OBSERVATION_LABELS[data.state] ?? "Evidence incomplete"}
            </h2>
            <p className="mt-3 break-words font-mono text-sm">
              {event?.operation.method} {event?.operation.path}
            </p>
          </div>
          <span className="text-sm">
            {event?.result.kind === "HTTP"
              ? `HTTP ${event.result.statusCode}`
              : (event?.result.kind ?? "Result unknown")}
          </span>
        </div>
        <dl className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-st-muted">Integration</dt>
            <dd className="mt-1 break-words">
              {event ? (
                <Link
                  className={`inline-flex min-h-11 items-center underline underline-offset-4 ${focusRing}`}
                  href={integrationHref(
                    event.integration.key,
                    event.integration.provider,
                    event.integration.environment,
                  )}
                >
                  {event.integration.key} / {event.integration.provider} /{" "}
                  {event.integration.environment}
                </Link>
              ) : (
                "Unverified metadata withheld"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-st-muted">Timing</dt>
            <dd className="mt-1">
              {event?.durationMs.toFixed(1) ?? "Unknown"} ms to headers / error
              · received {utc(data.receivedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-st-muted">Pinned baseline</dt>
            <dd className="mt-1">
              {data.baseline
                ? `${data.baseline.origin === "OBSERVED" ? "Observed shape" : "Stored OpenAPI response contract"} · revision ${data.baseline.version}`
                : "None selected when this call was received"}
            </dd>
          </div>
          <div>
            <dt className="text-st-muted">Reported provider version</dt>
            <dd className="mt-1">
              {event?.result.kind === "HTTP"
                ? (event.result.providerVersion ?? "Not reported")
                : "No response"}
            </dd>
          </div>
        </dl>
        {data.evidence?.changes.length ? (
          <div className="mt-5">
            <h3 className="font-medium">Expected versus observed structure</h3>
            {data.evidence.changes.map((change, index) => (
              <div
                key={index}
                className="mt-3 grid gap-2 border-t border-base-300 py-3 text-sm sm:grid-cols-[minmax(8rem,1fr)_1fr_1fr]"
              >
                <code className="break-all">{change.pointer}</code>
                <span>Expected {change.expectedType ?? "missing"}</span>
                <span>
                  Observed {change.receivedType ?? "missing"}
                  <small className="mt-1 block text-st-muted">
                    {change.rule.replaceAll("_", " ").toLowerCase()}
                  </small>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-st-muted">
            {data.state === "MATCH"
              ? "The selected fields match this baseline. This does not establish full-schema or business correctness."
              : data.state === "NO_RESPONSE"
                ? "No response was available to compare. No schema drift verdict can be made."
                : "This record does not establish a structural change. Missing or incomplete checks are not passing checks."}
          </p>
        )}
        <p className="mt-4 text-sm text-st-muted">
          {event?.capture.state === "CAPTURED"
            ? `${event.capture.pointers.length} selected fields checked; values were not retained.`
            : event?.capture.state === "OFF"
              ? "Response shape collection was off."
              : `Response shape unavailable${event?.capture.omission ? ` · ${event.capture.omission}` : ""}.`}
        </p>
        <details className="mt-2 text-sm">
          <summary className={`min-h-11 cursor-pointer py-3 ${focusRing}`}>
            Baseline provenance and check limits
          </summary>
          {data.baseline ? (
            <>
              <p className="break-all">
                Baseline {data.baseline.id} · stored{" "}
                {utc(data.baseline.createdAt)}
              </p>
              <p className="mt-2 break-all">
                {data.baseline.sampleObservationId
                  ? `Captured sample ${data.baseline.sampleObservationId}. An observed sample is not a provider promise.`
                  : `Stored OpenAPI ${data.baseline.apiSpecId}; source ${data.baseline.sourceSha256}.`}
              </p>
            </>
          ) : (
            <p>No response baseline was pinned at acceptance.</p>
          )}
          <p className="mt-3 text-st-muted">
            Comparisons use selected presence/types, not exhaustive JSON Schema.
            Arrays compare element types, not arbitrary nested item properties.
            Provider headers and stored baselines do not prove deployed
            versions. No AI interpretation is used.
          </p>
          {event ? (
            <Link
              className={`${secondaryAction} mt-3`}
              href={
                integrationHref(
                  event.integration.key,
                  event.integration.provider,
                  event.integration.environment,
                ) + "#baselines"
              }
            >
              Integration baselines
            </Link>
          ) : null}
        </details>
      </section>
      <section className={`${panel} p-4 sm:p-6`}>
        <h2 className="font-medium">Linked downstream outcomes</h2>
        <p className="mt-2 text-sm text-st-muted">
          Matched by explicit identifiers and attempt. Association does not
          establish that this API call caused the outcome.
        </p>
        {data.outcomes.length ? (
          <ul className="mt-4 divide-y divide-base-300">
            {data.outcomes.map((outcome) => (
              <li key={outcome.id} className="py-3 text-sm">
                <p className="font-medium">
                  {outcome.outcome} · {outcome.correlation.kind} attempt{" "}
                  {outcome.correlation.attempt}
                </p>
                <p className="mt-2 break-all font-mono text-xs">
                  {outcome.correlation.id}
                </p>
                <p className="mt-2 text-xs text-st-muted">
                  Reported {utc(outcome.occurredAt)} · received{" "}
                  {utc(outcome.receivedAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm">
            No linked outcome reported. Downstream success or failure is
            unknown.
          </p>
        )}
        {data.linksTruncated ? (
          <p className="mt-3 text-sm">
            Link limit reached; impact is incomplete.
          </p>
        ) : null}
        {data.invalidLinks ? (
          <p className="mt-3 text-sm">
            {data.invalidLinks} unverified links withheld.
          </p>
        ) : null}
        <details className="mt-2 text-sm">
          <summary className={`min-h-11 cursor-pointer py-3 ${focusRing}`}>
            Linking rules
          </summary>
          <p>
            Links require the same workspace, integration, provider,
            environment, identifier kind, UUID alias and attempt. Retries are
            separate attempts. Events may arrive in either order; time proximity
            alone creates no link.
          </p>
        </details>
      </section>
      <section className={`${panel} p-4 sm:p-6`}>
        <h2 className="font-medium">Related observations</h2>
        <p className="mt-2 text-sm">
          {data.totalRelated} retained calls share this baseline and drift
          signature.
        </p>
        <p className="mt-1 text-xs text-st-muted">
          Observed exposure, not caused failures. Up to 20 recent calls shown.
        </p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {data.related.map((row) => (
            <li key={row.id}>
              <Link
                className={secondaryAction}
                href={`/dashboard/observations/${row.id}`}
              >
                {row.id.slice(0, 8)}
                {row.id === data.id ? " · current" : ""}
              </Link>
            </li>
          ))}
        </ul>
        {data.request ? (
          <div className="mt-4">
            <Link
              href={`/dashboard/incidents?incident=${data.request.id}&inspect=1`}
              className={`inline-flex min-h-11 items-center text-sm underline underline-offset-4 ${focusRing}`}
            >
              Related request check: {data.request.validationStatus}
            </Link>
            <p className="text-xs text-st-muted">
              Integration-supplied reference; it does not prove the identical
              outbound payload was validated.
            </p>
          </div>
        ) : null}
      </section>
      <section className={`${panel} p-4 sm:p-6`}>
        <h2 className="font-medium">Investigation steps</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
          <li>
            If a field changed, compare it with provider documentation and your
            response mapper.
          </li>
          <li>
            Inspect the exact workflow trace. Auth, rate limits, business rules
            and other dependencies remain possible explanations.
          </li>
          <li>
            Confirm the running client/version and account for missing calls or
            outcomes before estimating impact.
          </li>
        </ul>
      </section>
    </div>
  );
}
