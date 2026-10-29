import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { IncidentReview, IncidentReviewSkeleton } from "@/components/dashboard/incident-review";

export const metadata: Metadata = {
  title: "Incidents · SpekTrace",
  robots: { index: false, follow: false },
};

type IncidentsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function IncidentsPage({ searchParams }: IncidentsPageProps) {
  // No dashboard authentication exists yet, so this screen must never be served by a production build.
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") {
    notFound();
  }

  return (
    <DashboardFrame>
      <Suspense fallback={<IncidentReviewSkeleton />}>
        <IncidentReview searchParams={searchParams} />
      </Suspense>
    </DashboardFrame>
  );
}
