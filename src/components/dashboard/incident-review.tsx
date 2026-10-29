import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import {
  DetailPlaceholder,
  IncidentDetail,
} from "@/components/dashboard/incident-detail";
import { InspectionFrame } from "@/components/dashboard/inspection-frame";
import { IncidentQueue } from "@/components/dashboard/incident-queue";
import { SeveritySelect } from "@/components/dashboard/severity-select";
import { QueueRefreshControls } from "@/components/dashboard/queue-refresh-controls";
import { RetryButton } from "@/components/dashboard/retry-button";
import { SelectionFocus } from "@/components/dashboard/selection-focus";
import { focusRing, panel } from "@/components/dashboard/styles";
import { reviewFixture } from "@/lib/dashboard/review-fixtures";
import {
  buildQueueHref,
  formatUtc,
  parseQueueQuery,
} from "@/lib/dashboard/queue-query";
import { loadIncidentReview } from "@/server/dashboard/incident-review-data";
import { loadPatternBoard } from "@/server/dashboard/pattern-board";

type SearchParams = Record<string, string | string[] | undefined>;

const DETAIL_PANEL_ID = "incident-detail";

function Problem({
  title,
  children,
  retry = false,
}: {
  title: string;
  children: ReactNode;
  retry?: boolean;
}) {
  return (
    <div role="alert" className={`${panel} flex max-w-2xl flex-col gap-3 p-5`}>
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="flex flex-col gap-2 text-base leading-relaxed text-st-muted">
        {children}
      </div>
      {retry ? (
        <div>
          <RetryButton />
        </div>
      ) : null}
    </div>
  );
}

export async function IncidentReview({
  searchParams,
  basePath = "/dashboard/incidents",
}: {
  searchParams: Promise<SearchParams>;
  basePath?: string;
}) {
  const raw = await searchParams;
  const fixtureValue = Array.isArray(raw.fixture)
    ? raw.fixture[0]
    : raw.fixture;
  const fixture = reviewFixture(fixtureValue);
  const query = parseQueueQuery(raw);
  await connection();
  const result = await loadIncidentReview(query);

  if (result.kind === "not-configured") {
    return (
      <Problem title="The local pilot workspace is not configured">
        <p>
          Set <span className="font-mono">SPEKTRACE_INTERNAL_WORKSPACE_ID</span>{" "}
          in your local environment file to the pilot workspace ID, then restart
          the dev server.
        </p>
        <p>
          Run{" "}
          <span className="font-mono">npm run pilot:print-workspace-id</span> to
          look up the ID.
        </p>
      </Problem>
    );
  }
  if (result.kind === "workspace-not-found") {
    return (
      <Problem title="The configured pilot workspace does not exist">
        <p>
          The workspace ID in{" "}
          <span className="font-mono">SPEKTRACE_INTERNAL_WORKSPACE_ID</span> was
          not found in the database. Run{" "}
          <span className="font-mono">npm run db:seed</span> and{" "}
          <span className="font-mono">npm run pilot:print-workspace-id</span>,
          then update the setting.
        </p>
      </Problem>
    );
  }
  if (result.kind === "database-unavailable") {
    return (
      <Problem title="The database could not be reached" retry>
        <p>
          Incidents could not be loaded, so this is not an empty queue. Check
          that PostgreSQL is running (
          <span className="font-mono">npm run infra:check</span>) and retry.
        </p>
      </Problem>
    );
  }

  const { queue, detail } = result;
  const effectiveQuery = { ...query, page: queue.page };
  const selectedId = detail.kind === "found" ? detail.incident.id : null;
  const loadedAt = formatUtc(result.loadedAt) ?? "";
  const shown = fixture ?? (detail.kind === "found" ? detail.incident : null);

  if (
    !fixture &&
    query.view !== "patterns" &&
    query.selected.kind === "none" &&
    queue.rows[0]
  ) {
    redirect(
      buildQueueHref(
        effectiveQuery,
        { incidentId: queue.rows[0].id },
        basePath,
      ),
    );
  }
  const patterns =
    query.view === "patterns" || query.inspect
      ? await loadPatternBoard({
          service: query.service,
          environment: query.environment,
        })
      : null;

  const label = shown
    ? `${shown.httpMethod} ${shown.requestPath}`
    : "Inspection";
  const selectionKey = shown
    ? shown.id
    : detail.kind === "unavailable"
      ? "unavailable"
      : null;
  const queueNode =
    queue.counts.all === 0 && queue.counts.history === 0 ? (
      <div className="flex flex-col gap-3 p-4">
        <QueueRefreshControls loadedAt={loadedAt} hasPending={false} />
        <h2 className="text-sm font-medium">No incidents yet</h2>
        <p className="text-sm leading-relaxed text-st-muted">
          Nothing has been submitted to this workspace. With the dev server and
          worker running, run{" "}
          <span className="font-mono">npm run demo:incident-flow</span> to
          submit a sample incident.
        </p>
      </div>
    ) : (
      <IncidentQueue
        query={effectiveQuery}
        queue={queue}
        selectedId={selectedId}
        loadedAt={loadedAt}
        basePath={basePath}
      />
    );

  const body = (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto flex max-w-[90rem] flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">
              Request validation evidence
            </h1>
            <p className="mt-1 text-xs text-st-muted">
              Environment · {query.environment ?? "All environments"}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <Link
            href={buildQueueHref(effectiveQuery, { view: "queue" }, basePath)}
            aria-current={query.view === "queue" ? "page" : undefined}
            className={`inline-flex h-8 items-center rounded-md px-2 text-xs ${focusRing} ${query.view === "queue" ? "bg-base-300" : "text-st-muted"}`}
          >
            Queue
          </Link>
          <Link
            href={buildQueueHref(
              effectiveQuery,
              { view: "patterns" },
              basePath,
            )}
            aria-current={query.view === "patterns" ? "page" : undefined}
            className={`inline-flex h-8 items-center rounded-md px-2 text-xs ${focusRing} ${query.view === "patterns" ? "bg-base-300" : "text-st-muted"}`}
          >
            Patterns
          </Link>
        </div>
        {query.view === "patterns" ? (
          <section className={`${panel} p-4`}>
            <h2 className="text-sm font-medium">Mismatch patterns</h2>
            {patterns?.kind !== "ok" ? (
              <p className="mt-3 text-sm text-st-muted">
                Patterns could not be loaded.
              </p>
            ) : patterns.patterns.patterns.length === 0 ? (
              <p className="mt-3 text-sm text-st-muted">
                No mismatch patterns are stored for this scope.
              </p>
            ) : (
              <ul className="mt-2">
                {patterns.patterns.patterns.map((pattern) => (
                  <li
                    key={pattern.key}
                    className="flex items-center justify-between gap-3 border-t border-base-300 py-3"
                  >
                    <div>
                      <p className="font-mono text-sm">{pattern.path}</p>
                      <p className="text-xs text-st-muted">
                        {pattern.rule} · {pattern.method}{" "}
                        {pattern.operationPath}
                      </p>
                    </div>
                    {pattern.exampleIncidentId ? (
                      <Link
                        href={buildQueueHref(
                          effectiveQuery,
                          {
                            incidentId: pattern.exampleIncidentId,
                            inspect: true,
                            view: "patterns",
                          },
                          basePath,
                        )}
                        className={`text-xs text-accent underline underline-offset-4 ${focusRing}`}
                      >
                        Inspect
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <div className={`${panel} min-h-full`}>{queueNode}</div>
        )}
      </div>
    </div>
  );

  return (
    <InspectionFrame
      open={query.inspect && selectionKey !== null}
      closeHref={buildQueueHref(effectiveQuery, { inspect: false }, basePath)}
      label={label}
      inspector={
        <>
          {fixture ? (
            <p className="border-b border-base-300 px-4 py-3 text-sm text-st-muted">
              Example only. This is not a stored incident, and nothing here was
              written to the database.
            </p>
          ) : null}
          {!fixture && detail.kind === "found" ? (
            <div className="flex items-center justify-between gap-3 border-b border-base-300 px-4 py-3">
              <p className="text-xs text-st-muted">Incident</p>
            </div>
          ) : null}
          {shown ? (
            <IncidentDetail
              incident={shown}
              aiExplanation={
                !fixture && detail.kind === "found"
                  ? detail.aiExplanation
                  : null
              }
            />
          ) : detail.kind === "unavailable" ? (
            <DetailPlaceholder title="This incident is not available">
              <p>
                It does not exist in this workspace, or the link is malformed.
              </p>
              <Link
                href={buildQueueHref(
                  effectiveQuery,
                  { incidentId: null, inspect: false },
                  basePath,
                )}
                scroll={false}
                className={`mt-3 inline-flex min-h-11 items-center text-sm text-accent underline underline-offset-4 ${focusRing}`}
              >
                Clear selection
              </Link>
            </DetailPlaceholder>
          ) : (
            <DetailPlaceholder title="Select an incident">
              <p>
                Choose a row to read the stored explanation, request, and
                specification.
              </p>
            </DetailPlaceholder>
          )}
          {patterns?.kind === "ok" && patterns.patterns.patterns.length > 0 ? (
            <section className="border-t border-base-300 px-4 py-4">
              <h3 className="text-sm font-medium">Pattern severity</h3>
              <p className="mt-1 text-xs text-st-muted">
                Manual assignment. Frequency does not set this value.
              </p>
              <ul className="mt-3 flex flex-col gap-3">
                {patterns.patterns.patterns.map((pattern) => (
                  <li key={pattern.key}>
                    <p className="font-mono text-xs">{pattern.path}</p>
                    <p className="mt-1 text-xs text-st-muted">{pattern.rule}</p>
                    <div className="mt-2">
                      <SeveritySelect
                        patternKey={pattern.key}
                        severity={pattern.severity}
                        provenance={pattern.severityProvenance}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <SelectionFocus incidentId={selectedId} targetId={DETAIL_PANEL_ID} />
        </>
      }
    >
      {body}
    </InspectionFrame>
  );
}

export function IncidentReviewSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <p className="text-base text-st-muted" role="status">
        Loading incidents…
      </p>
      <div className="grid gap-6 min-[1440px]:grid-cols-[minmax(28rem,0.9fr)_minmax(0,1.15fr)]">
        <div className={`${panel} flex flex-col`}>
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="skeleton mx-4 my-3 h-10" />
          ))}
        </div>
        <div className={`${panel} hidden px-6 py-5 min-[1440px]:block`}>
          <p className="text-sm text-st-muted">Select an incident.</p>
        </div>
      </div>
    </div>
  );
}
