import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { IntegrationsDirectory } from "@/components/dashboard/integrations-view";
import {
  panel,
  secondaryAction,
  focusRing,
} from "@/components/dashboard/styles";
import { getPrisma } from "@/lib/db";

import {
  integrationScopeSchema,
  loadIntegrationDirectory,
} from "@/server/dashboard/integrations";
export const metadata: Metadata = {
  title: "Integrations · SpekTrace",
  robots: { index: false, follow: false },
};
async function Body({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const raw = await searchParams;
  const parsed = integrationScopeSchema.safeParse({
    svc: raw.svc || undefined,
    env: raw.env || undefined,
    provider: raw.provider || undefined,
  });
  if (!parsed.success)
    return (
      <main className="p-6">
        <h1 className="text-xl font-semibold">Invalid integration scope</h1>
        <p className="mt-3">
          Use the configured integration, provider and environment labels.
        </p>
      </main>
    );
  let data: Awaited<ReturnType<typeof loadIntegrationDirectory>> | null = null;
  try {
    data = await loadIntegrationDirectory(
      getPrisma(),
      (await getDashboardWorkspaceId()),
      parsed.data,
    );
  } catch {}
  const input = `mt-1 block min-h-11 w-60 max-w-full rounded-md border border-base-300 bg-base-200 px-3 text-sm ${focusRing}`;
  return (
    <main className="h-full overflow-y-auto p-4 sm:p-8">
      <div className="w-full space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4"><div>
          <h1 className="text-xl font-semibold">Integrations</h1>
          <p className="mt-2 text-sm text-st-muted">
            Connect outbound calls, confirm capture, then investigate changes.
          </p>
        </div></header>
        <form className="flex flex-wrap items-end gap-3" method="get">
          <label className="max-w-full text-xs text-st-muted">
            Integration
            <input
              className={input}
              name="svc"
              defaultValue={parsed.data.svc}
              placeholder="All integrations"
            />
          </label>
          <label className="max-w-full text-xs text-st-muted">
            Environment
            <input
              className={input}
              name="env"
              defaultValue={parsed.data.env}
              placeholder="All environments"
            />
          </label>
          {parsed.data.provider ? (
            <input type="hidden" name="provider" value={parsed.data.provider} />
          ) : null}
          <button className={secondaryAction}>Apply scope</button>
        </form>
        {data ? (
          <IntegrationsDirectory data={data} />
        ) : (
          <section className={`${panel} p-5`} role="status">
            <h2 className="font-medium">Integrations could not be loaded</h2>
            <p className="mt-2 text-sm">
              Refresh to try again. This is not an empty integration list.
            </p>
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
      <Suspense fallback={<p className="p-6">Loading integrations…</p>}>
        <Body {...props} />
      </Suspense>
    </DashboardFrame>
  );
}
