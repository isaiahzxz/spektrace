import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import {
  ObservationList,
  ObservationNotice,
} from "@/components/dashboard/integration-observations-view";
import { ObservationRefresh } from "@/components/dashboard/observation-refresh";
import {
  panel,
  focusRing,
  secondaryAction,
} from "@/components/dashboard/styles";
import { getPrisma } from "@/lib/db";

import { listObservations } from "@/server/dashboard/integration-observations";
import {
  parseObservationFilters,
  observationHref,
} from "@/lib/dashboard/observation-query";
export const metadata: Metadata = {
  title: "Observations · SpekTrace",
  robots: { index: false, follow: false },
};
async function Body({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const parsed = parseObservationFilters(await searchParams);
  if (!parsed.success)
    return (
      <main className="h-full overflow-y-auto p-6">
        <h1 className="text-xl font-semibold">Check the observation filters</h1>
        <p className="mt-3 text-sm">
          Use configured labels, both valid UTC dates in order, and a positive
          page number.
        </p>
        <Link
          href="/dashboard/observations"
          className={`${secondaryAction} mt-4`}
        >
          Reset filters
        </Link>
      </main>
    );
  const filters = parsed.data;
  let data: Awaited<ReturnType<typeof listObservations>> | null = null;
  try {
    data = await listObservations(
      getPrisma(),
      (await getDashboardWorkspaceId()),
      filters,
    );
  } catch {}
  const input = `mt-1 block min-h-11 w-full min-w-0 rounded-md border border-base-300 bg-base-200 px-3 text-sm text-base-content ${focusRing}`;
  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-[96rem] space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Observations</h1>
            <div className="mt-2">
              <ObservationNotice />
            </div>
          </div>
          <ObservationRefresh />
        </header>
        {filters.notice ? (
          <p role="status" className="text-sm text-st-muted">
            These are outbound calls. Client-version filters from the older
            report are not applied here.{" "}
            <Link
              href={observationHref(filters, { notice: undefined })}
              className={`underline ${focusRing}`}
            >
              Dismiss
            </Link>
          </p>
        ) : null}
        <form method="get" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label className="min-w-0 text-xs text-st-muted">
              Integration
              <input
                name="svc"
                defaultValue={filters.svc}
                placeholder="All integrations"
                className={input}
              />
            </label>
            <label className="min-w-0 text-xs text-st-muted">
              Environment
              <input
                name="env"
                defaultValue={filters.env}
                placeholder="All environments"
                className={input}
              />
            </label>
            <div className="grid min-w-0 grid-cols-2 gap-3 sm:col-span-2">
              <label className="min-w-0 text-xs text-st-muted">
                Received from (UTC)
                <input
                  type="date"
                  name="from"
                  defaultValue={filters.from}
                  className={input}
                />
              </label>
              <label className="min-w-0 text-xs text-st-muted">
                Received to (UTC)
                <input
                  type="date"
                  name="to"
                  defaultValue={filters.to}
                  className={input}
                />
              </label>
            </div>
          </div>
          <details
            open={
              filters.provider || filters.finding || filters.http
                ? true
                : undefined
            }
          >
            <summary
              className={`min-h-11 cursor-pointer py-3 text-sm ${focusRing}`}
            >
              Finding and provider filters
            </summary>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-xs text-st-muted">
                Finding
                <select
                  name="finding"
                  defaultValue={filters.finding ?? ""}
                  className={input}
                >
                  <option value="">All findings</option>
                  <option value="drift">Observed response drift</option>
                  <option value="contract">Response contract mismatch</option>
                  <option value="no-response">No response</option>
                  <option value="pending">Processing</option>
                  <option value="incomplete">Incomplete / no baseline</option>
                  <option value="match">Selected fields match</option>
                </select>
              </label>
              <label className="text-xs text-st-muted">
                HTTP result
                <select
                  name="http"
                  defaultValue={filters.http ?? ""}
                  className={input}
                >
                  <option value="">All HTTP / transport results</option>
                  <option value="4xx">HTTP 4xx</option>
                  <option value="5xx">HTTP 5xx</option>
                </select>
              </label>
              <label className="text-xs text-st-muted">
                Provider
                <input
                  name="provider"
                  defaultValue={filters.provider}
                  placeholder="All providers"
                  className={input}
                />
              </label>
            </div>
          </details>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className={secondaryAction}>
              Apply filters
            </button>
            <Link className={secondaryAction} href="/dashboard/observations">
              Clear
            </Link>
          </div>
        </form>
        {data ? (
          <ObservationList data={data} filters={filters} />
        ) : (
          <section className={`${panel} p-5`} role="status">
            <h2 className="font-medium">Observations could not be loaded</h2>
            <p className="mt-2 text-sm">
              Refresh to try again. The store is unavailable; this is not an
              empty result.
            </p>
            <div className="mt-3">
              <ObservationRefresh />
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
export default function Page(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return (
    <DashboardFrame>
      <Suspense
        fallback={
          <p className="p-6" aria-busy="true">
            Loading observations…
          </p>
        }
      >
        <Body {...props} />
      </Suspense>
    </DashboardFrame>
  );
}
