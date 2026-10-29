import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { IntegrationContext } from "@/components/dashboard/integrations-view";
import { secondaryAction } from "@/components/dashboard/styles";
import { getPrisma } from "@/lib/db";

import {
  integrationScopeSchema,
  loadIntegrationContext,
} from "@/server/dashboard/integrations";
export const metadata: Metadata = {
  title: "Integration · SpekTrace",
  robots: { index: false, follow: false },
};
type Props = {
  params: Promise<{ integrationKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
async function Body({ params, searchParams }: Props) {
  await connection();
  const { integrationKey } = await params,
    raw = await searchParams;
  const parsed = integrationScopeSchema.safeParse({
    env: raw.env || undefined,
    provider: raw.provider || undefined,
  });
  if (!parsed.success)
    return <main className="p-6">Invalid integration scope.</main>;
  let data: Awaited<ReturnType<typeof loadIntegrationContext>> = null,
    failed = false;
  try {
    data = await loadIntegrationContext(
      getPrisma(),
      (await getDashboardWorkspaceId()),
      integrationKey,
      parsed.data,
    );
  } catch {
    failed = true;
  }
  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <Link href="/dashboard/integrations" className={secondaryAction}>
            All integrations
          </Link>
          <h1 className="mt-4 break-words text-xl font-semibold">
            {data?.key ?? "Integration"}
          </h1>
          <p className="mt-2 text-sm text-st-muted">
            {parsed.data.provider ?? "All recorded providers"} ·{" "}
            {parsed.data.env ?? "All environments"}
          </p>
        </header>
        {data ? (
          <IntegrationContext
            data={data}
            provider={parsed.data.provider}
            environment={parsed.data.env}
          />
        ) : (
          <p role="status">
            {failed
              ? "Integration could not be loaded. Refresh to try again."
              : "Integration unavailable in this workspace."}
          </p>
        )}
      </div>
    </main>
  );
}
export default function Page(props: Props) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return (
    <DashboardFrame>
      <Suspense fallback={<p className="p-6">Loading integration…</p>}>
        <Body {...props} />
      </Suspense>
    </DashboardFrame>
  );
}
