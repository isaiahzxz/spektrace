import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { OnboardingFlow } from "@/components/dashboard/onboarding-flow";

export const metadata = { title: "Notifications · SpekTrace", robots: { index: false, follow: false } };
async function Body() { await connection(); return <main className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-6xl"><h1 className="mb-6 text-2xl font-semibold">Notifications & status</h1><OnboardingFlow workspaceId={(await getDashboardWorkspaceId())} notificationsOnly={true}/></div></main>; }
export default function Page() { if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true")
    notFound(); return <DashboardFrame><Suspense fallback={<p className="p-6">Loading setup…</p>}><Body /></Suspense></DashboardFrame>; }
