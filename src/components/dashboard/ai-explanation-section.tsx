import type { ReactNode } from "react";
import type { IncidentAiExplanationView } from "@/server/dashboard/incident-inference-data";

function Notice({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-st-muted">{children}</p>;
}

export function AiExplanationSection({ view }: { view: IncidentAiExplanationView }) {
  return (
    <section className="border-t border-base-300 px-4 py-6 sm:px-6" aria-labelledby="ai-explanation-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 id="ai-explanation-heading" className="text-base font-semibold">
          AI explanation
        </h3>
        <span className="rounded-full border border-base-300 px-2 py-0.5 text-xs text-st-muted">
          Generated · requires human review
        </span>
      </div>

      {view.state === "disabled" ? (
        <Notice>AI investigation explanations are disabled for this workspace.</Notice>
      ) : null}
      {view.state === "not-configured" ? (
        <Notice>
          Inference is not configured. Set <span className="font-mono">SPEKTRACE_AI_INFERENCE_ADAPTER</span> to{" "}
          <span className="font-mono">test</span> or configure OpenUI Gateway with{" "}
          <span className="font-mono">THESYS_API_KEY</span> on the server.
        </Notice>
      ) : null}
      {view.state === "not-grouped" ? (
        <Notice>This incident is not part of an investigation group yet.</Notice>
      ) : null}
      {view.state === "preparing" ? (
        <Notice>Protected evidence for this group is still being prepared.</Notice>
      ) : null}
      {view.state === "queued" ? <Notice>An AI explanation job is queued.</Notice> : null}
      {view.state === "running" ? <Notice>AI explanation is running.</Notice> : null}
      {view.state === "failed" ? (
        <Notice>
          Explanation generation failed
          {view.failureCode ? ` (${view.failureCode})` : ""}. Deterministic findings above remain authoritative.
        </Notice>
      ) : null}

      {view.state === "available" ? (
        <div className="flex flex-col gap-5">
          {view.newerEvidenceAvailable ? (
            <p className="text-sm text-warning">
              Newer grouped evidence is available. This explanation covers membership version{" "}
              <span className="font-mono tabular-nums">{view.membershipVersion}</span>.
            </p>
          ) : null}
          <p className="text-sm text-st-muted">
            {view.groupedIncidentCount} grouped incident(s) · {view.includedEvidenceCount} evidence bundle(s) included
            {view.omittedEvidenceCount > 0 ? ` · ${view.omittedEvidenceCount} omitted by preparation limits` : ""}
            {view.unavailableEvidenceCount > 0 ? ` · ${view.unavailableEvidenceCount} unavailable at generation time` : ""}
          </p>
          <div>
            <h4 className="text-sm font-medium">Summary</h4>
            <p className="mt-2 text-base leading-relaxed">{view.output.summary}</p>
          </div>
          <div>
            <h4 className="text-sm font-medium">Observed findings</h4>
            <ul className="mt-2 flex flex-col gap-2 text-sm leading-relaxed">
              {view.output.observedFindings.map((row, index) => (
                <li key={`finding-${index}`}>
                  {row.description}
                  <span className="text-st-muted"> · cites {row.citationIds.join(", ")}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-medium">Evidence citations</h4>
            <ul className="mt-2 flex flex-col gap-1 font-mono text-xs text-st-muted">
              {view.output.evidenceCitations.map((row) => (
                <li key={row.id}>{row.id}: {row.label}</li>
              ))}
            </ul>
          </div>
          {view.documentationCitations.length > 0 ? (
            <div>
              <h4 className="text-sm font-medium">Documentation citations</h4>
              <ul className="mt-2 flex flex-col gap-4 text-sm leading-relaxed">
                {view.documentationCitations.map((row) => (
                  <li key={row.id} className="rounded-lg border border-base-300 bg-base-200/40 p-3 dark:bg-base-300/20">
                    <p className="font-mono text-xs text-st-muted">
                      {row.id} · {row.title} · {row.documentId}
                      {row.contentVersion ? ` · v${row.contentVersion}` : ""} · {row.section}:{row.startLine}-{row.endLine}
                    </p>
                    <p className="mt-2 text-xs text-st-muted">{row.applicabilityNote}</p>
                    {row.trustedSourceUrl ? (
                      <p className="mt-2 text-xs">
                        <a
                          href={row.trustedSourceUrl}
                          className="link link-hover text-primary"
                          rel="noopener noreferrer"
                        >
                          Configured source reference
                        </a>
                      </p>
                    ) : null}
                    <pre className="mt-3 overflow-x-auto rounded-md bg-base-300/30 p-3 font-mono text-xs leading-relaxed dark:bg-base-300/40">
                      {row.excerpt}
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.deploymentCitations.length > 0 ? (
            <div>
              <h4 className="text-sm font-medium">Deployment citations</h4>
              <ul className="mt-2 flex flex-col gap-4 text-sm leading-relaxed">
                {view.deploymentCitations.map((row) => (
                  <li key={row.id} className="rounded-lg border border-base-300 bg-base-200/40 p-3 dark:bg-base-300/20">
                    <p className="font-mono text-xs text-st-muted">
                      {row.id} · {row.status} · {row.service}/{row.environment} · {row.sourceDeploymentRef}
                    </p>
                    <p className="mt-2 text-xs text-st-muted">
                      Event (source): <span className="font-mono">{row.sourceReportedAt}</span>
                      {" · "}
                      Received: <span className="font-mono">{row.receivedAt}</span>
                    </p>
                    {row.commitSha ? (
                      <p className="mt-2 font-mono text-xs text-st-muted">Commit: {row.commitSha}</p>
                    ) : null}
                    {row.artifactRef ? (
                      <p className="mt-1 font-mono text-xs text-st-muted">Artifact: {row.artifactRef}</p>
                    ) : null}
                    <p className="mt-2 text-xs text-st-muted">{row.relationshipNote}</p>
                    <p className="mt-2 text-xs text-st-muted">{row.uncertaintyNote}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.repositoryCitations.length > 0 ? (
            <div>
              <h4 className="text-sm font-medium">Repository citations</h4>
              <ul className="mt-2 flex flex-col gap-4 text-sm leading-relaxed">
                {view.repositoryCitations.map((row) => (
                  <li key={row.id} className="rounded-lg border border-base-300 bg-base-200/40 p-3 dark:bg-base-300/20">
                    <p className="font-mono text-xs text-st-muted">
                      {row.id} · {row.repository}@{row.commitSha.slice(0, 7)} · {row.file}:{row.startLine}-{row.endLine}
                    </p>
                    <p className="mt-2 text-xs text-st-muted">{row.deploymentRelationshipNote}</p>
                    <pre className="mt-3 overflow-x-auto rounded-md bg-base-300/30 p-3 font-mono text-xs leading-relaxed dark:bg-base-300/40">
                      {row.excerpt}
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.output.hypotheses && view.output.hypotheses.length > 0 ? (
            <div>
              <h4 className="text-sm font-medium">Hypotheses (not verified)</h4>
              <ul className="mt-2 flex flex-col gap-2 text-sm leading-relaxed">
                {view.output.hypotheses.map((row) => (
                  <li key={row.label}>
                    <span className="font-medium">{row.label}:</span> {row.description}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <h4 className="text-sm font-medium">Limitations</h4>
            <ul className="mt-2 list-disc pl-5 text-sm leading-relaxed text-st-muted">
              {view.output.limitations.map((row) => (
                <li key={row}>{row}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-medium">Suggested manual checks</h4>
            <ol className="mt-2 list-decimal pl-5 text-sm leading-relaxed">
              {view.output.suggestedSteps.map((row) => (
                <li key={row}>{row}</li>
              ))}
            </ol>
          </div>
          <dl className="grid gap-3 border-t border-base-300 pt-4 text-xs text-st-muted sm:grid-cols-2">
            <div>
              <dt>Evidence version</dt>
              <dd className="font-mono [overflow-wrap:anywhere]">{view.membershipVersion}</dd>
            </div>
            <div>
              <dt>Input hash</dt>
              <dd className="font-mono [overflow-wrap:anywhere]">{view.evidenceInputHash.slice(0, 16)}…</dd>
            </div>
            <div>
              <dt>Prompt/schema</dt>
              <dd className="font-mono [overflow-wrap:anywhere]">{view.promptSchemaVersion}</dd>
            </div>
            {view.generatedAt ? (
              <div>
                <dt>Generated (UTC)</dt>
                <dd className="font-mono">{view.generatedAt}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </section>
  );
}
