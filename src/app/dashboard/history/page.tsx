import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DriftText, MethodMark } from "@/components/dashboard/badges";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { HistoryRangeForm } from "@/components/dashboard/history-range-form";
import { BucketChart } from "@/components/dashboard/request-history-chart";
import { focusRing, panel } from "@/components/dashboard/styles";
import {
  historyHref,
  parseHistoryRange,
  type HistoryStateFilter,
} from "@/lib/dashboard/history-range";
import { shortIncidentId } from "@/lib/dashboard/queue-query";
import { loadHistoryReport } from "@/server/dashboard/history-data";

export const metadata: Metadata = {
  title: "Request archive · SpekTrace",
  robots: { index: false, follow: false },
};

const STATES: Array<{ value: HistoryStateFilter; label: string }> = [
  { value: "all", label: "All states" },
  { value: "review", label: "Awaiting review" },
  { value: "accepted", label: "Accepted" },
];

function Chart({
  points,
}: {
  points: Array<{ label: string; axis: string; count: number }>;
}) {
  return (
    <BucketChart
      points={points}
      label="Captured incidents received in the selected UTC interval. Each label uses the same x position as its bucket."
    />
  );
}

async function HistoryBody({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const raw = await searchParams;
  const range = parseHistoryRange(raw);
  const result = range.error
    ? { kind: "invalid-range" as const }
    : await loadHistoryReport(range);

  return (
    <main className="h-full overflow-y-auto p-4">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <header>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-lg font-semibold">Incidents received</h1>
          </div>
          <p className="mt-1 text-xs text-st-muted">
            Environment · {range.environment ?? "All environments"}
          </p>

          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-st-muted">
            This report lists incidents received during the selected UTC
            interval and shows their currently recorded outcomes. It is not a
            snapshot of their state at that past moment. The end date is
            inclusive. This is separate from the queue’s Accepted filter.
          </p>
        </header>
        <section className={`${panel} p-4`}>
          <HistoryRangeForm
            from={range.from}
            to={range.to}
            state={range.state}
            service={range.service}
            environment={range.environment}
            error={range.error}
          />
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Cohort filter">
            {STATES.map((item) => (
              <Link
                key={item.value}
                href={historyHref(range, { state: item.value, page: 1 })}
                aria-current={range.state === item.value ? "true" : undefined}
                className={`inline-flex min-h-10 items-center rounded-full px-3 text-sm ${focusRing} ${range.state === item.value ? "bg-base-300" : "text-st-muted hover:bg-base-300"}`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </section>
        {result.kind === "invalid-range" ? null : result.kind !== "ok" ? (
          <p className={`${panel} p-4 text-sm`}>
            The report could not be loaded.
          </p>
        ) : (
          <>
            <section className={`${panel} p-4`}>
              <h2 className="text-sm font-medium">Incident activity</h2>
              <p className="mt-1 text-xs text-st-muted">
                {range.from} to {range.to} UTC · {result.report.total} incidents
                received. Not total API traffic.
              </p>
              <div className="mt-3">
                {result.report.volume.length === 0 ? (
                  <p className="text-sm text-st-muted">
                    No buckets in this interval.
                  </p>
                ) : (
                  <Chart points={result.report.volume} />
                )}
              </div>
            </section>
            <section className={`${panel} p-4`}>
              <h2 className="text-sm font-medium">Contract checks</h2>
              <p className="mt-2 text-3xl font-semibold tabular-nums">
                {result.report.passedRate === null
                  ? "Not enough data"
                  : `${result.report.passedRate}%`}
              </p>
              <p className="mt-1 text-sm text-st-muted">
                {result.report.supported === 0
                  ? "No supported body check in this cohort."
                  : `${result.report.outcomes.passed} of ${result.report.supported} supported body checks passed. Unsupported (${result.report.outcomes.unsupported}) and failed (${result.report.outcomes.failed}) checks are excluded from that rate.`}
              </p>
            </section>
            <section className={`${panel} p-4`}>
              <h2 className="text-sm font-medium">Mismatch patterns</h2>
              <p className="mt-1 text-xs text-st-muted">
                Same received-at cohort.
                {result.report.patternLimited
                  ? ` Patterns use the latest ${result.report.patterns.sampled} of ${result.report.total} incidents.`
                  : " Every incident in the cohort was considered."}
              </p>
              {result.report.patterns.patterns.length === 0 ? (
                <p className="mt-3 text-sm">
                  No mismatch patterns in this cohort.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-base-300">
                  {result.report.patterns.patterns.map((pattern) => (
                    <li
                      key={pattern.key}
                      className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                    >
                      <span className="font-mono text-sm">{pattern.path}</span>
                      <span className="font-mono text-xs tabular-nums text-st-muted">
                        {pattern.frequency} incidents · {pattern.specLabel}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className={`${panel} overflow-x-auto`}>
              <header className="px-4 py-3">
                <h2 className="text-sm font-medium">Incidents</h2>
                <p className="text-xs text-st-muted">
                  {result.report.total} in this cohort
                </p>
              </header>
              {result.report.rows.length === 0 ? (
                <p className="px-4 pb-4 text-sm">
                  No incidents were received in this interval.
                </p>
              ) : (
                <table className="w-full min-w-[40rem] table-fixed text-left">
                  <colgroup>
                    <col className="w-[7rem]" />
                    <col />
                    <col className="w-[10rem]" />
                    <col className="w-[14rem]" />
                  </colgroup>
                  <thead>
                    <tr className="font-mono text-xs text-st-muted">
                      <th className="px-4 py-2 font-medium">Id</th>
                      <th className="px-3 py-2 font-medium">Request</th>
                      <th className="px-3 py-2 font-medium">Finding</th>
                      <th className="px-3 py-2 font-medium">Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.report.rows.map((row) => (
                      <tr key={row.id} className="border-t border-base-300">
                        <td className="px-4 py-3 align-middle">
                          <Link
                            href={`/dashboard?incident=${row.id}&inspect=1`}
                            className={`font-mono text-xs text-accent underline underline-offset-4 ${focusRing}`}
                          >
                            {shortIncidentId(row.id)}
                          </Link>
                        </td>
                        <td className="max-w-0 truncate px-3 py-3 align-middle font-mono text-sm">
                          <MethodMark method={row.httpMethod} />{" "}
                          {row.requestPath}
                        </td>
                        <td className="max-w-0 truncate px-3 py-3 align-middle">
                          <DriftText
                            label={row.drift.label}
                            tone={row.drift.tone}
                          />
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 align-middle font-mono text-xs text-st-muted">
                          {row.receivedAt}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {result.report.totalPages > 1 ? (
                <div className="flex gap-3 border-t border-base-300 px-4 py-3 text-sm">
                  {range.page > 1 ? (
                    <Link
                      href={historyHref(range, { page: range.page - 1 })}
                      className={focusRing}
                    >
                      Previous
                    </Link>
                  ) : (
                    <span className="text-st-muted">Previous</span>
                  )}
                  <span className="font-mono tabular-nums text-st-muted">
                    Page {range.page} of {result.report.totalPages}
                  </span>
                  {range.page < result.report.totalPages ? (
                    <Link
                      href={historyHref(range, { page: range.page + 1 })}
                      className={focusRing}
                    >
                      Next
                    </Link>
                  ) : (
                    <span className="text-st-muted">Next</span>
                  )}
                </div>
              ) : null}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

export default function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return (
    <DashboardFrame>
      <Suspense
        fallback={
          <p className="p-4 text-sm text-st-muted">
            Loading the historical range.
          </p>
        }
      >
        <HistoryBody searchParams={searchParams} />
      </Suspense>
    </DashboardFrame>
  );
}
