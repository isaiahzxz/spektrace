import { publicAnnouncement } from "@/lib/dashboard/announcement";
import { headers } from "next/headers";
import { accountMode,getAccountAuth } from "@/server/accounts/auth";
import { readAnnouncement,canEditAnnouncements } from "@/server/dashboard/announcements";
import { Suspense, type ReactNode } from "react";
import { DashboardShell } from "./dashboard-shell";
import { loadPilotWorkspace } from "@/server/dashboard/incident-review-data";
async function Workspace({ children }: { children: ReactNode }) {
  const lookup = await loadPilotWorkspace();
  const [board,canEdit,session]=await Promise.all([readAnnouncement(),canEditAnnouncements(),accountMode()?getAccountAuth().api.getSession({headers:await headers()}):null]);
  return (
    <DashboardShell
      announcement={publicAnnouncement(board.announcement)} announcementsAvailable={board.available} canEditAnnouncements={canEdit} userName={session?.user.name}
      workspace={
        lookup.kind === "ok" ? lookup.workspace.name : "Workspace unavailable"
      }
    >
      {children}
    </DashboardShell>
  );
}
export function DashboardFrame({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div
          className="flex h-dvh items-start bg-st-bg p-6 text-base-content"
          aria-busy="true"
        >
          Loading workspace…
        </div>
      }
    >
      <Workspace>{children}</Workspace>
    </Suspense>
  );
}
