import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { focusRing, panel } from "@/components/dashboard/styles";
import { shortIncidentId } from "@/lib/dashboard/queue-query";
import { loadPilotActivity } from "@/server/dashboard/header-data";

export const metadata: Metadata = {
  title: "Audit log · SpekTrace",
  robots: { index: false, follow: false },
};

async function AuditBody() {
  await connection();
  let notices: Awaited<ReturnType<typeof loadPilotActivity>>["notices"] = [];
  let failed = false;
  try {
    notices = (await loadPilotActivity(40)).notices;
  } catch {
    failed = true;
  }

  return (
    <main className="h-full overflow-y-auto p-4">
      <section className={`${panel} mx-auto max-w-3xl`}>
        <header className="border-b border-base-300 px-4 py-3">
          <h1 className="text-lg font-semibold">Audit log</h1>
          
          <p className="mt-1 text-sm text-st-muted">Recorded events for this workspace. This list is read-only and is not filtered by environment. It is separate from historical date-range analysis.</p>
        </header>
        {failed ? <p className="px-4 py-6 text-sm">The audit log could not be loaded.</p> : null}
        {!failed && notices.length === 0 ? <p className="px-4 py-6 text-sm">No audit events are stored.</p> : null}
        <ul>
          {notices.map((event) => (
            <li key={event.id} className="border-b border-base-300 px-4 py-3 last:border-b-0">
              <p className={`text-sm ${event.failed ? "text-error" : ""}`}>{event.label}</p>
              <p className="mt-1 text-xs text-st-muted">
                <time className="font-mono tabular-nums">{event.at}</time>
                <span> · {event.actor}</span>
                {event.incidentId ? (
                  <>
                    {" · "}
                    <Link href={`/dashboard?incident=${event.incidentId}&inspect=1`} className={`font-mono text-accent underline underline-offset-4 ${focusRing}`}>
                      {shortIncidentId(event.incidentId)}
                    </Link>
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

export default function AuditPage() {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return (
    <DashboardFrame>
      <Suspense fallback={<p className="p-4 text-sm text-st-muted">Loading the audit log.</p>}>
        <AuditBody />
      </Suspense>
    </DashboardFrame>
  );
}
