import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { ObservationDetail } from "@/components/dashboard/integration-observations-view";
import { ObservationRefresh } from "@/components/dashboard/observation-refresh";
import { secondaryAction } from "@/components/dashboard/styles";
import { getPrisma } from "@/lib/db";

import { parseObservationFilters,observationHref } from "@/lib/dashboard/observation-query";
import { loadObservation } from "@/server/dashboard/integration-observations";
export const metadata: Metadata = {
  title: "Investigation · SpekTrace",
  robots: { index: false, follow: false },
};
async function Body({
  params,searchParams,
}: {
  params: Promise<{ observationId: string }>;searchParams:Promise<Record<string,string|string[]|undefined>>;
}) {
  await connection();
  const { observationId } = await params;
  const parsedFilters=parseObservationFilters(await searchParams);const back=parsedFilters.success?observationHref(parsedFilters.data):"/dashboard/observations";
  let data: Awaited<ReturnType<typeof loadObservation>> = null,
    unavailable = false;
  try {
    data = await loadObservation(
      getPrisma(),
      (await getDashboardWorkspaceId()),
      observationId,
    );
  } catch {
    unavailable = true;
  }
  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header>
          <div className="flex flex-wrap items-center justify-between gap-3"><Link href={back} className={secondaryAction}>
            All observations
          </Link><ObservationRefresh /></div>
          <h1 className="mt-4 text-xl font-semibold">
            Integration investigation
          </h1>
          <div className="mt-2">
            <p className="text-sm text-st-muted">
              Compare the response structure and review recorded downstream
              outcomes.
            </p>
          </div>
        </header>

        {data ? (
          <ObservationDetail data={data} />
        ) : (
          <p role="status">
            {unavailable
              ? "Investigation could not be loaded. Refresh to try again."
              : "Observation unavailable in this workspace."}
          </p>
        )}
      </div>
    </main>
  );
}
export default function Page(props: {
  params: Promise<{ observationId: string }>;searchParams:Promise<Record<string,string|string[]|undefined>>;
}) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return (
    <DashboardFrame>
      <Suspense
        fallback={
          <main className="p-6" aria-busy="true">
            Loading integration investigation.
          </main>
        }
      >
        <Body {...props} />
      </Suspense>
    </DashboardFrame>
  );
}
