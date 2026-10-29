import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActivateRevisionForm } from "@/components/dashboard/activate-revision-form";
import { DashboardFrame } from "@/components/dashboard/dashboard-frame";
import { focusRing, panel } from "@/components/dashboard/styles";
import { formatUtc } from "@/lib/dashboard/queue-query";
import { compareOpenApiDocuments } from "@/lib/openapi/semantic-diff";
import { relateIncident } from "@/lib/specs/revision-decisions";

import { getPrisma } from "@/lib/db";

export const metadata: Metadata = {
  title: "Specification revisions · SpekTrace",
  robots: { index: false, follow: false },
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function RevisionBody({
  service,
  searchParams,
}: {
  service: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const raw = await searchParams;
  const environment = first(raw.environment) || first(raw.env) || "default";
  const leftId = first(raw.left) ?? "";
  const rightId = first(raw.right) ?? "";
  const prisma = getPrisma();
  const workspaceId = (await getDashboardWorkspaceId());
  const revisions = await prisma.apiSpec.findMany({
    where: { workspaceId, apiKey: service, environment },
    orderBy: { revisionSequence: "desc" },
  });
  if (revisions.length === 0) {
    return (
      <main className="p-4 text-sm">
        No revisions are stored for this service and environment.
      </main>
    );
  }
  const left =
    revisions.find((revision) => revision.id === leftId) ??
    revisions[Math.min(1, revisions.length - 1)];
  const right =
    revisions.find((revision) => revision.id === rightId) ?? revisions[0];
  const compared =
    left && right && left.id !== right.id
      ? compareOpenApiDocuments(left.parsedDocument, right.parsedDocument)
      : null;
  const changedFields = (compared?.changes ?? []).flatMap((change) => {
    if (change.area !== "request") return [];
    const match =
      /^(POST|GET|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE) (\S+) (\S+)$/.exec(
        change.subject,
      );
    if (!match) return [];
    return [
      {
        method: match[1],
        path: match[2],
        pointer: match[3],
        revisions: [left.id, right.id],
      },
    ];
  });
  const activatedAt =
    right.activatedAt &&
    left.activatedAt &&
    right.activatedAt > left.activatedAt
      ? right.activatedAt
      : right.activatedAt;
  const incidents = compared
    ? await prisma.incident.findMany({
        where: { workspaceId, apiKey: service, environment },
        orderBy: { receivedAt: "desc" },
        take: 40,
        select: {
          id: true,
          httpMethod: true,
          requestPath: true,
          apiSpecId: true,
          receivedAt: true,
          validationEvidence: true,
        },
      })
    : [];
  const related = incidents.flatMap((incident) => {
    const evidence = incident.validationEvidence as {
      findings?: Array<{ jsonPointer?: string }>;
    } | null;
    const relation = relateIncident({
      method: incident.httpMethod,
      path: incident.requestPath,
      pinnedSpecId: incident.apiSpecId,
      findingPointers:
        evidence?.findings?.flatMap((finding) =>
          finding.jsonPointer ? [finding.jsonPointer] : [],
        ) ?? [],
      receivedAt: incident.receivedAt,
      changedFields,
      activatedAt,
    });
    return relation === "none"
      ? []
      : [
          {
            id: incident.id,
            relation,
            method: incident.httpMethod,
            path: incident.requestPath,
          },
        ];
  });
  const name = revisions[0]?.name ?? service;
  return (
    <main className="h-full overflow-y-auto p-4">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <header>
          <p className="text-xs text-st-muted">
            <Link
              href={`/dashboard/integrations/${encodeURIComponent(service)}?env=${encodeURIComponent(environment)}`}
              className={focusRing}
            >
              API specifications
            </Link>
          </p>
          <h1 className="mt-1 text-lg font-semibold">{name}</h1>

          <p className="mt-1 font-mono text-xs text-st-muted">
            {service} · {environment}
          </p>
        </header>
        <section className={`${panel} p-4`}>
          <h2 className="text-sm font-medium">Revisions</h2>
          <p className="mt-1 text-xs text-st-muted">
            Import time is not a deployment time. Activation is recorded only
            when an activation succeeded.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {revisions.map((revision) => (
              <li key={revision.id} className="border-t border-base-300 pt-3">
                <p className="font-mono text-sm">{revision.version}</p>
                <p className="text-xs text-st-muted">
                  {revision.isActive
                    ? "Activated"
                    : revision.activatedAt
                      ? "No longer active"
                      : "Imported"}
                  {" · imported "}
                  <time className="font-mono">
                    {formatUtc(revision.createdAt)}
                  </time>
                  {revision.activatedAt ? (
                    <>
                      {" "}
                      · activated{" "}
                      <time className="font-mono">
                        {formatUtc(revision.activatedAt)}
                      </time>
                    </>
                  ) : null}
                </p>
                <p className="font-mono text-xs text-st-muted">
                  {String(revision.sourceSha256).slice(0, 12)}
                </p>

                {!revision.isActive ? (
                  <ActivateRevisionForm
                    revisionId={revision.id}
                    label={`${name}, ${environment}, ${revision.version}`}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        <section className={`${panel} p-4`}>
          <h2 className="text-sm font-medium">Compare revisions</h2>
          <form className="mt-3 flex flex-wrap items-end gap-3" method="get">
            <input type="hidden" name="environment" value={environment} />
            <label className="text-sm">
              Earlier
              <select
                name="left"
                defaultValue={left?.id}
                className={`mt-1 block min-h-11 rounded-md border border-base-300 bg-base-100 px-2 font-mono text-xs ${focusRing}`}
              >
                {revisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {revision.version}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Later
              <select
                name="right"
                defaultValue={right?.id}
                className={`mt-1 block min-h-11 rounded-md border border-base-300 bg-base-100 px-2 font-mono text-xs ${focusRing}`}
              >
                {revisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {revision.version}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={`inline-flex min-h-11 items-center rounded-md border border-base-300 px-3 text-sm ${focusRing}`}
              type="submit"
            >
              Compare
            </button>
            {!left || !right || left.id === right.id ? (
              <p className="text-xs text-st-muted">
                Comparison needs two different revisions.
              </p>
            ) : null}
          </form>
          {compared ? (
            <div className="mt-4">
              <p className="text-xs leading-relaxed text-st-muted">
                {compared.limitation}
              </p>
              {compared.changes.length === 0 ? (
                <p className="mt-3 text-sm">
                  No supported semantic changes were found.
                </p>
              ) : (
                <ul className="mt-3 flex flex-col gap-2">
                  {compared.changes.map((change) => (
                    <li
                      key={`${change.area}-${change.kind}-${change.subject}`}
                      className="text-sm"
                    >
                      <span className="font-mono text-xs">
                        {change.classification}
                      </span>{" "}
                      {change.kind}
                      <p className="font-mono text-xs text-st-muted">
                        {change.area} · {change.subject}
                      </p>
                      <p className="text-xs text-st-muted">{change.detail}</p>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="mt-4 text-sm font-medium">
                Related captured incidents
              </h3>
              {related.length === 0 ? (
                <p className="mt-2 text-sm text-st-muted">
                  No stored evidence matched these changes, and none were
                  received after the later activation.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {related.map((incident) => (
                    <li key={`${incident.id}-${incident.relation}`}>
                      <Link
                        className={`font-mono text-xs ${focusRing}`}
                        href={`/dashboard?incident=${incident.id}&inspect=1`}
                      >
                        {incident.id.slice(0, 8)}
                      </Link>
                      <span className="text-xs text-st-muted">
                        {" "}
                        {incident.method} {incident.path} · {incident.relation}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-st-muted">
              Two different revisions are needed for a comparison.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

type RevisionPageProps = {
  params: Promise<{ service: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
async function ResolvedRevision({ params, searchParams }: RevisionPageProps) {
  const { service } = await params;
  return (
    <RevisionBody
      service={decodeURIComponent(service)}
      searchParams={searchParams}
    />
  );
}
export default function SpecServicePage(props: RevisionPageProps) {
  if (process.env.NODE_ENV !== "development" && process.env.SPEKTRACE_ACCOUNTS_ENABLED!=="true") notFound();
  return (
    <DashboardFrame>
      <Suspense
        fallback={<main className="p-4 text-sm">Loading revisions.</main>}
      >
        <ResolvedRevision {...props} />
      </Suspense>
    </DashboardFrame>
  );
}
