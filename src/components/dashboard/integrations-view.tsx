import Link from "next/link";
import type {
  loadIntegrationDirectory,
  loadIntegrationContext,
} from "@/server/dashboard/integrations";
import { integrationHref } from "@/server/dashboard/integrations";
import { observationHref } from "@/lib/dashboard/observation-query";
import { panel, secondaryAction, focusRing } from "./styles";
import { ObserverSetup } from "./observer-setup";
const utc = (value: string) => value.replace("T", " ").replace("Z", " UTC");
function ScopeList({
  data,
}: {
  data: Awaited<ReturnType<typeof loadIntegrationDirectory>>;
}) {
  return !data.integrations.length ? (
    <section className={`${panel} p-5`}>
      <h2 className="font-medium">
        {data.filtered
          ? "No integrations match this scope"
          : "No outbound integration recorded"}
      </h2>
      <p className="mt-2 text-sm text-st-muted">
        No observer, capture report or response baseline is recorded in this
        scope. Stored request contracts alone do not establish a connection.
      </p>
      {data.filtered ? (
        <Link
          className={`${secondaryAction} mt-4`}
          href="/dashboard/integrations"
        >
          Clear scope
        </Link>
      ) : (
        <a className={`${secondaryAction} mt-4`} href="#setup">
          Set up capture
        </a>
      )}
    </section>
  ) : (
    <section className={panel}>
      <div className="p-4">
        <h2 className="font-medium">Recorded integrations</h2>
        <p className="mt-2 text-sm text-st-muted">
          Capture status reflects received evidence, not provider health.
        </p>
      </div>
      <ul className="divide-y divide-base-300">
        {data.integrations.map((row) => (
          <li
            key={`${row.identity.key}/${row.identity.provider}/${row.identity.environment}`}
            className="grid gap-4 p-4 lg:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_auto]"
          >
            <div>
              <Link
                className={`inline-flex min-h-11 items-center font-semibold underline decoration-base-300 underline-offset-4 ${focusRing}`}
                href={integrationHref(
                  row.identity.key,
                  row.identity.provider,
                  row.identity.environment,
                )}
              >
                {row.identity.key}
              </Link>
              <p className="text-xs text-st-muted">
                {row.identity.provider} · {row.identity.environment}
              </p>
            </div>
            <div className="text-sm">
              <p>{row.state}</p>
              <p className="mt-2 text-xs text-st-muted">
                {row.calls} retained calls
                {row.lastReceived
                  ? ` · last received ${utc(row.lastReceived)}`
                  : ""}
              </p>
              <p className="mt-1 text-xs text-st-muted">
                {row.coverageReportedAt
                  ? `Latest capture report ${utc(row.coverageReportedAt)}`
                  : "Collection coverage unknown"}
              </p>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <Link
                href={observationHref({
                  page: 1,
                  svc: row.identity.key,
                  provider: row.identity.provider,
                  env: row.identity.environment,
                })}
                className={secondaryAction}
              >
                View calls
              </Link>
              <>{row.calls===0&&<Link href={"/dashboard/onboarding?"+new URLSearchParams({integration:row.identity.key,provider:row.identity.provider,environment:row.identity.environment})} className={secondaryAction}>Continue setup</Link>}</>
              <Link
                href={
                  integrationHref(
                    row.identity.key,
                    row.identity.provider,
                    row.identity.environment,
                  ) + "#baselines"
                }
                className={secondaryAction}
              >
                Baselines
              </Link>
            </div>
          </li>
        ))}
      </ul>
      {data.truncated ? (
        <p className="p-4 text-sm">
          Showing the first 100 scopes. Narrow the integration/environment
          filters.
        </p>
      ) : null}
      {data.invalidScopes ? (
        <p className="p-4 text-sm">
          {data.invalidScopes} invalid scope records withheld.
        </p>
      ) : null}
    </section>
  );
}
function SupportingContracts({
  data,
}: {
  data: Awaited<ReturnType<typeof loadIntegrationDirectory>>;
}) {
  return (
    <details id="request-contracts" className={`${panel} p-4 sm:p-6`}>
      <summary
        className={`min-h-11 cursor-pointer py-2 font-medium ${focusRing}`}
      >
        Stored request contracts and webhook evidence
      </summary>
      <p className="mt-3 text-sm text-st-muted">
        These are supporting records. An imported contract or accepted webhook
        does not prove outbound capture is working.
      </p>
      {data.contracts.length ? (
        <ul className="mt-4 divide-y divide-base-300">
          {data.contracts.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <p className="text-sm font-medium">{row.name}</p>
                <p className="mt-1 text-xs text-st-muted">
                  {row.service} · {row.environment} · latest import{" "}
                  {row.version}
                </p>
              </div>
              <Link
                href={`/dashboard/specs/${encodeURIComponent(row.service)}?environment=${encodeURIComponent(row.environment)}`}
                className={secondaryAction}
              >
                Request revisions
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-st-muted">
          No request contracts recorded in this scope.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href={
            "/dashboard/webhooks" +
            (data.scope.svc || data.scope.env
              ? "?" +
                new URLSearchParams({
                  ...(data.scope.svc ? { svc: data.scope.svc } : {}),
                  ...(data.scope.env ? { env: data.scope.env } : {}),
                })
              : "")
          }
          className={secondaryAction}
        >
          Webhook evidence ({data.webhooks})
        </Link>
        <Link href="/dashboard/webhooks/stripe" className={secondaryAction}>
          Stripe evidence
        </Link>
      </div>
      <p className="mt-2 text-xs text-st-muted">
        {data.stripe} stored Stripe webhook sources. Stripe evidence is
        workspace-wide; that adapter does not record a service/environment
        association.
      </p>
      {data.contractsTruncated ? (
        <p className="mt-2 text-sm">
          Request contract list limited to 100 service/environment scopes.
        </p>
      ) : null}
    </details>
  );
}
export function IntegrationsDirectory({
  data,
}: {
  data: Awaited<ReturnType<typeof loadIntegrationDirectory>>;
}) {
  return (
    <>
      <ScopeList data={data} />
      <ObserverSetup hasCredential={data.credentialCount > 0} />
      <SupportingContracts data={data} />
    </>
  );
}
export function IntegrationContext({
  data,
  environment,
  provider,
}: {
  data: NonNullable<Awaited<ReturnType<typeof loadIntegrationContext>>>;
  environment?: string;
  provider?: string;
}) {
  const identity =
    data.integrations.length === 1 ? data.integrations[0].identity : undefined;
  const observe = observationHref({
    page: 1,
    svc: data.key,
    env: environment,
    provider,
  });
  return (
    <>
      <div className="flex flex-wrap gap-3">
        <Link href={observe} className={secondaryAction}>
          View observations
        </Link>
        <a href="#baselines" className={secondaryAction}>
          Response baselines
        </a>
        <a href="#setup" className={secondaryAction}>
          Capture setup
        </a>
      </div>
      <ScopeList data={data} />
      <section id="baselines" className={`${panel} scroll-mt-6 p-4 sm:p-6`}>
        <h2 className="font-medium">Response baselines</h2>
        <p className="mt-2 text-sm text-st-muted">
          An observed baseline describes a captured shape. A contract baseline
          checks selected fields from a stored OpenAPI response. Each call keeps
          the baseline selected when it was received.
        </p>
        {data.baselines.length ? (
          <ul className="mt-4 divide-y divide-base-300">
            {data.baselines.map((row) => (
              <li key={row.id} className="py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-sm">
                      {row.method} {row.path} · HTTP {row.statusCode}
                    </p>
                    <p className="mt-2 text-sm">
                      {row.origin === "OBSERVED"
                        ? "Observed shape"
                        : "Stored OpenAPI contract"}{" "}
                      · revision {row.version} ·{" "}
                      {row.active ? "Selected for new calls" : "Not selected"}
                    </p>
                    <p className="mt-1 text-xs text-st-muted">
                      {row.provider} · {row.environment} · stored{" "}
                      {utc(row.createdAt)}
                    </p>
                  </div>
                  {row.sampleObservationId ? (
                    <Link
                      href={`/dashboard/observations/${row.sampleObservationId}`}
                      className={secondaryAction}
                    >
                      Source call
                    </Link>
                  ) : null}
                </div>
                <details className="mt-2">
                  <summary
                    className={`min-h-11 cursor-pointer py-3 text-sm ${focusRing}`}
                  >
                    Selected fields and provenance
                  </summary>
                  <ul className="space-y-2 font-mono text-xs">
                    {row.fields.map((field) => (
                      <li key={field.pointer} className="break-words">
                        {field.pointer} · {field.type ?? "missing"}
                        {row.origin === "CONTRACT"
                          ? field.required
                            ? " · required"
                            : " · optional"
                          : ""}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 break-all font-mono text-xs text-st-muted">
                    Baseline {row.id}
                    {row.apiSpecId
                      ? ` · contract ${row.apiSpecId} · source ${row.sourceSha256}`
                      : ""}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm">
            No response baseline recorded in this scope. Capture a selected
            shape or configure a supported response contract before interpreting
            drift.
          </p>
        )}
        {data.baselinesTruncated ? (
          <p className="mt-3 text-sm">
            Showing 100 baseline revisions. Narrow the provider/environment
            scope.
          </p>
        ) : null}
        <details className="mt-3">
          <summary
            className={`min-h-11 cursor-pointer py-3 text-sm ${focusRing}`}
          >
            Configure or select a response baseline
          </summary>
          <p className="text-sm">
            Use the existing server admin API{" "}
            <code>POST /api/internal/response-baselines</code>. It requires the
            separate admin bearer; do not place that credential in browser code.
          </p>
          <div className="mt-3 space-y-3 text-sm">
            <p>
              1. To create an observed baseline, send{" "}
              <code>
                {'{"action":"observe","observationId":"SOURCE_CALL_UUID"}'}
              </code>
              . The call must have opt-in selected response shapes.
            </p>
            <p>
              2. For a stored contract, send action <code>contract</code> with
              this integration identity, method/path, status code, selected
              pointers, stored <code>apiSpecId</code> and its actual{" "}
              <code>sourceSha256</code>.
            </p>
            <p>
              3. Creation is inactive. Select separately with{" "}
              <code>
                {'{"action":"activate","baselineId":"BASELINE_UUID"}'}
              </code>
              . This is baseline selection, not proof of deployment.
            </p>
          </div>
          <p className="mt-3 text-sm text-st-muted">
            The API is functional; this screen is read-only. Supported
            comparisons cover selected types/required presence in inline JSON
            OpenAPI 3.1, not exhaustive schema compatibility.
          </p>
        </details>
      </section>
      <ObserverSetup
        integration={identity}
        hasCredential={data.credentialCount > 0}
      />
      <SupportingContracts data={data} />
    </>
  );
}
