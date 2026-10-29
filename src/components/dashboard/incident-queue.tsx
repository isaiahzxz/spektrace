import Link from "next/link";
import { DriftText, MethodMark, StatusBadge } from "@/components/dashboard/badges";
import { IncidentIdCopy } from "@/components/dashboard/copy-text-button";
import { LiveRefresh } from "@/components/dashboard/live-refresh";
import { QueueRefreshControls } from "@/components/dashboard/queue-refresh-controls";
import { focusRing, rowHover, rowSelected, secondaryAction } from "@/components/dashboard/styles";
import type { QueueFilter } from "@/lib/dashboard/incident-status";
import { buildQueueHref, type QueueQuery } from "@/lib/dashboard/queue-query";
import type { IncidentQueuePage } from "@/server/dashboard/incident-review-data";

const FILTERS: Array<{ value: QueueFilter; label: string }> = [
  { value: "all", label: "Active" },
  { value: "pending", label: "Pending" },
  { value: "triaged", label: "Triaged" },
  { value: "history", label: "Accepted" },
];

const EMPTY_FILTER_TEXT: Record<QueueFilter, string> = {
  all: "No incidents are waiting for review.",
  pending: "Nothing is waiting to be checked.",
  triaged: "No incident has finished its automated check yet.",
  history: "No tested correction has been accepted yet.",
};

function FilterLinks({
  query,
  counts,
  basePath,
}: {
  query: QueueQuery;
  counts: IncidentQueuePage["counts"];
  basePath: string;
}) {
  return (
    <nav aria-label="Filter incidents" className="flex max-w-full flex-wrap gap-1 rounded-md bg-base-300 p-1">
      {FILTERS.map((filter) => {
        const active = query.filter === filter.value;
        return (
          <Link
            key={filter.value}
            href={buildQueueHref(query, { filter: filter.value, page: 1 }, basePath)}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-11 items-center gap-2 rounded-md border-2 px-3 text-sm ${focusRing} ${
              active
                ? "border-base-content bg-base-100 font-semibold text-base-content"
                : "border-transparent font-normal text-st-muted hover:border-base-content/30 hover:bg-base-200 hover:text-base-content"
            }`}
          >
            {filter.label}
            <span className={`min-w-5 text-right font-mono text-sm tabular-nums ${active ? "font-semibold text-base-content" : "text-st-muted"}`}>
              {counts[filter.value]}
            </span>
            {active ? <span className="sr-only">selected</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

function Pagination({ query, queue, basePath }: { query: QueueQuery; queue: IncidentQueuePage; basePath: string }) {
  if (queue.totalPages <= 1) return null;
  const linkClass = secondaryAction;
  const disabledClass = "inline-flex min-h-11 items-center rounded-md px-3 text-sm text-st-muted pointer-events-none";

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-base-300 px-4 py-4 sm:px-6">
      <div className="flex gap-2">
        {queue.page > 1 ? (
          <Link href={buildQueueHref(query, { page: queue.page - 1 }, basePath)} scroll={false} className={linkClass}>
            Previous
          </Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>Previous</span>
        )}
        {queue.page < queue.totalPages ? (
          <Link href={buildQueueHref(query, { page: queue.page + 1 }, basePath)} scroll={false} className={linkClass}>
            Next
          </Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>Next</span>
        )}
      </div>
      <p className="font-mono text-sm tabular-nums text-st-muted">
        Page {queue.page} of {queue.totalPages}
      </p>
    </nav>
  );
}

export function IncidentQueue({
  query,
  queue,
  selectedId,
  loadedAt,
  basePath = "/dashboard/incidents",
}: {
  query: QueueQuery;
  queue: IncidentQueuePage;
  selectedId: string | null;
  loadedAt: string;
  basePath?: string;
}) {
  const start = (queue.page - 1) * queue.pageSize + 1;
  const end = start + queue.rows.length - 1;

  return (
    <section id="incident-queue" aria-labelledby="queue-heading" className="@container flex min-w-0 flex-col">
      <div className="flex flex-col gap-2 px-4 py-2 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="queue-heading" className="text-base font-semibold">
            Incident queue
          </h2>
          {queue.rows.length > 0 ? (
            <p className="font-mono text-sm tabular-nums text-st-muted">
              {start}–{end} of {queue.counts[query.filter]}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <FilterLinks query={query} counts={queue.counts} basePath={basePath} />
          <div className="flex flex-wrap items-center gap-3">
            <LiveRefresh />
            <QueueRefreshControls loadedAt={loadedAt} hasPending={queue.counts.pending > 0} />
          </div>
        </div>
        <p className="sr-only">Triaged means the automated check finished, including unsupported results. It does not mean someone approved the incident.</p>
        {queue.counts.failed > 0 ? (
          <p className="text-sm text-error">
            {queue.counts.failed} {queue.counts.failed === 1 ? "check" : "checks"} failed. Failed checks stay in Active.
          </p>
        ) : null}
      </div>

      {queue.rows.length === 0 ? (
        <div className="border-t border-base-300 px-4 py-6 sm:px-6">
          <p className="text-base font-medium">{EMPTY_FILTER_TEXT[query.filter]}</p>
          {query.filter !== "all" ? (
            <Link
              href={buildQueueHref(query, { filter: "all", page: 1 }, basePath)}
              scroll={false}
              className={`mt-3 inline-flex min-h-11 items-center text-sm text-accent underline underline-offset-4 ${focusRing}`}
            >
              Show all incidents
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="border-t border-base-300">
          <table className="hidden w-full table-fixed text-left @min-[52rem]:[display:table]">
            <colgroup>
              <col className="w-[10%]" />
              <col className="w-[24%]" />
              <col className="w-[22%]" />
              <col className="w-[22%]" />
              <col className="w-[14%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead>
              <tr className="font-mono text-xs text-st-muted">
                <th className="px-3 py-2 font-medium">Id</th>
                <th className="px-3 py-2 font-medium">Request</th>
                <th className="px-3 py-2 font-medium">Finding</th>
                <th className="px-3 py-2 font-medium">Received</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Review</th>
              </tr>
            </thead>
            <tbody>
              {queue.rows.map((row) => {
                const selected = row.id === selectedId;
                return (
                  <tr key={row.id} className={`border-t border-base-300 ${rowHover} ${selected ? rowSelected : ""}`}>
                    <td className="px-3 align-middle">
                      <IncidentIdCopy id={row.id} shortId={row.shortId} />
                      {selected ? <span className="sr-only">selected</span> : null}
                    </td>
                    <td className="max-w-0 px-3 align-middle">
                      <Link
                        href={buildQueueHref(query, { incidentId: row.id, inspect: false }, basePath)}
                        scroll={false}
                        prefetch={false}
                        aria-current={selected ? "true" : undefined}
                        className={`flex min-h-[3.25rem] min-w-0 items-center gap-2 ${focusRing}`}
                      >
                        <MethodMark method={row.httpMethod} />
                        <span className="min-w-0 truncate font-mono text-sm" title={row.requestPath}>{row.requestPath}</span>
                      </Link>
                    </td>
                    <td className="px-3 align-middle font-mono text-xs">
                      <span className="block whitespace-normal break-words">
                        <DriftText label={row.drift.label} tone={row.drift.tone} />
                      </span>
                    </td>
                    <td className="px-3 align-middle font-mono text-xs tabular-nums leading-snug text-st-muted">
                      {row.statusCode} · {row.receivedAt}
                    </td>
                    <td className="whitespace-nowrap px-3 align-middle">
                      <StatusBadge category={row.category} label={row.categoryLabel} />
                    </td>
                    <td className="px-3 align-middle">
                      <Link
                        href={buildQueueHref(query, { incidentId: row.id, inspect: true }, basePath)}
                        scroll={false}
                        className={`inline-flex h-9 items-center rounded-md border border-base-300 px-3 text-xs ${focusRing}`}
                      >
                        Review
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ul className="@min-[52rem]:hidden" aria-label="Incidents">
            {queue.rows.map((row) => {
              const selected = row.id === selectedId;
              return (
                <li key={row.id} className={`border-b border-base-300 px-4 py-3 ${selected ? rowSelected : ""}`}>
                  <div className="flex items-center justify-between gap-3">
                    <IncidentIdCopy id={row.id} shortId={row.shortId} />
                    <Link href={buildQueueHref(query, { incidentId: row.id, inspect: true }, basePath)} className={`inline-flex h-9 items-center rounded-md border border-base-300 px-3 text-xs ${focusRing}`}>
                      Review
                    </Link>
                  </div>
                  <Link href={buildQueueHref(query, { incidentId: row.id, inspect: false }, basePath)} className={`mt-1 flex min-w-0 items-center gap-2 ${focusRing}`}>
                    <MethodMark method={row.httpMethod} />
                    <span className="truncate font-mono text-sm">{row.requestPath}</span>
                  </Link>
                  <p className="mt-1 whitespace-normal break-words font-mono text-sm"><DriftText label={row.drift.label} tone={row.drift.tone} /></p>
                  <p className="mt-1 font-mono text-xs text-st-muted">{row.statusCode} · {row.receivedAt}</p>
                  <div className="mt-2"><StatusBadge category={row.category} label={row.categoryLabel} /></div>
                </li>
              );
            })}
          </ul>
          <Pagination query={query} queue={queue} basePath={basePath} />
        </div>
      )}
    </section>
  );
}