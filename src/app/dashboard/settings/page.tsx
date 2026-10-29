import { AnnouncementEditor } from "@/components/dashboard/announcement-editor";
import { readAnnouncement,canEditAnnouncements } from "@/server/dashboard/announcements";
import { accountMode } from "@/server/accounts/auth";
import { SignOutButton } from "@/components/dashboard/account-form";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { ThemeSwitch } from "@/components/dashboard/theme-switch";
import { panel, secondaryAction } from "@/components/dashboard/styles";
import { loadPilotWorkspace } from "@/server/dashboard/incident-review-data";
export const metadata: Metadata = {
  title: "Settings · SpekTrace",
  robots: { index: false, follow: false },
};
async function Body() {
  await connection();
  const lookup = await loadPilotWorkspace();
  const [board,canEdit]=await Promise.all([readAnnouncement(),canEditAnnouncements()]);
  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="mt-2 text-sm text-st-muted">
            Appearance and workspace information.
          </p>
        </header>
        {canEdit&&<AnnouncementEditor initial={board.announcement} available={board.available}/>}
        <section className={`${panel} p-5`}><h2 className="font-medium">Notifications & status</h2><p className="mt-2 text-sm text-st-muted">Grouped alerts, optional digests and a quick terminal status check.</p><Link className={`${secondaryAction} mt-4`} href="/dashboard/settings/notifications">Configure notifications</Link></section>
        <section className={`${panel} p-5`}>
          <h2 className="font-medium">Appearance</h2>
          <p className="mt-2 text-sm text-st-muted">Saved in this browser.</p>
          <div className="mt-4 max-w-xs">
            <ThemeSwitch />
          </div>
        </section>
        <section className={`${panel} p-5`} id="runtime">
          {accountMode()?<SignOutButton/>:<Link className={secondaryAction} href="/sign-up">Review account creation</Link>}
          <h2 className="font-medium">Workspace access</h2>
          <p className="mt-2 text-sm">
            {lookup.kind === "ok"
              ? lookup.workspace.name
              : "Workspace unavailable"}
          </p>
          <p className="mt-2 text-sm text-st-muted">
            {accountMode()?"Your workspace is scoped to your signed-in account.":"This is a local review workspace. Account sign-in is not enabled."}
          </p>
          <details className="mt-3 text-sm">
            <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-accent">
              Configuration details
            </summary>
            <p className="break-all font-mono text-xs">
              Workspace ID:{" "}
              {lookup.kind === "ok" ? lookup.workspace.id : "Not configured"}
            </p>
            <p className="mt-3">
              Capture policy and credentials are configured on your server, not
              in this browser. Retention is operator-managed; no automatic purge
              is configured.
            </p>
            <Link
              href="/dashboard/integrations#setup"
              className={`${secondaryAction} mt-3`}
            >
              Capture setup
            </Link>
          </details>
        </section>
        <section className={`${panel} p-5`}>
          <h2 className="font-medium">Supporting records</h2>
          <p className="mt-2 text-sm text-st-muted">
            Historical request evidence and audit records remain available
            separately from outbound observations.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link className={secondaryAction} href="/dashboard/audit">
              Audit history
            </Link>
            <Link className={secondaryAction} href="/dashboard/history">
              Request archive
            </Link>
            <Link className={secondaryAction} href="/dashboard/incidents">
              Request validation evidence
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
export default function Page() {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return (
    <DashboardFrame>
      <Suspense fallback={<p className="p-6">Loading settings…</p>}>
        <Body />
      </Suspense>
    </DashboardFrame>
  );
}
