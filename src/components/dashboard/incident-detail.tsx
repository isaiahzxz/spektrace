import type { ReactNode } from "react";
import { MethodMark, StatusBadge } from "@/components/dashboard/badges";
import { CopyTextButton } from "@/components/dashboard/copy-text-button";
import { OpenUiEvidence } from "@/components/dashboard/openui/evidence-panel";
import { SandboxTester } from "@/components/dashboard/sandbox-tester";
import { buildIncidentProgram, type EvidenceProgramInput } from "@/lib/openui/incident-program";
import { focusRing, inset } from "@/components/dashboard/styles";
import { AiExplanationSection } from "@/components/dashboard/ai-explanation-section";
import type {
  EvidencePanelView,
  IncidentDetailView,
  RequestBodyView,
  SpecPanelView,
} from "@/lib/dashboard/incident-view-models";
import type { IncidentAiExplanationView } from "@/server/dashboard/incident-inference-data";

function Section({ title, children, aside, id }: { title: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section id={id} className="border-t border-base-300 px-4 py-6 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-st-muted">{label}</dt>
      <dd className="mt-1 break-words font-mono text-sm tabular-nums">{children}</dd>
    </div>
  );
}

const codeBlock = `max-h-96 overflow-auto p-4 font-mono text-sm leading-6 tabular-nums text-base-content select-text ${inset} ${focusRing}`;

function RedactionNote({ format, redactedPaths }: { format: EvidencePanelView["format"]; redactedPaths: string[] }) {
  const rule =
    'SpekTrace only replaces values of fields with credential-like names (password, token, secret, api_key) with "[REDACTED]". Other personal data is stored as submitted.';
  if (format !== "v1") {
    return <p className="mt-3 text-sm leading-relaxed text-st-muted">Which fields were redacted was not recorded. {rule}</p>;
  }
  return (
    <p className="mt-3 text-sm leading-relaxed text-st-muted">
      {redactedPaths.length > 0 ? (
        <>
          Redacted fields: <span className="break-all font-mono text-base-content">{redactedPaths.join(", ")}</span>.{" "}
        </>
      ) : (
        "No fields were redacted. "
      )}
      {rule}
    </p>
  );
}

function RequestBody({ body }: { body: RequestBodyView }) {
  if (body.kind === "missing") {
    return <p className="text-base text-st-muted">No request body was submitted with this incident.</p>;
  }
  if (body.kind === "unreadable") {
    return <p className="text-base text-st-muted">The stored request body could not be displayed.</p>;
  }
  return (
    <div>
      {body.isJsonNull ? <p className="mb-3 text-sm text-st-muted">The submitted body was the JSON value null.</p> : null}
      <pre className={codeBlock} tabIndex={0} aria-label="Sanitized request body">
        {body.text}
      </pre>
    </div>
  );
}

function TechnicalDetails({ evidence }: { evidence: EvidencePanelView }) {
  if (!evidence.technicalJson) return null;
  return (
    <details className="mt-4 border-t border-base-300 pt-3">
      <summary className={`min-h-11 cursor-pointer text-sm font-medium text-accent ${focusRing}`}>
        Technical details
      </summary>
      <div className="pb-2">
        <dl className="grid gap-4 sm:grid-cols-2">
          <Meta label="Checked at">{evidence.checkedAt ?? "not recorded"}</Meta>
          <Meta label="Validator">{evidence.validatorLabel ?? "not recorded"}</Meta>
          <Meta label="Redacted paths">{evidence.redactedPaths.length > 0 ? evidence.redactedPaths.join(", ") : "none recorded"}</Meta>
          <Meta label="Evidence format">{evidence.format}</Meta>
        </dl>
        {evidence.findings.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-1 font-mono text-sm text-st-muted">
            {evidence.findings.map((finding, index) => (
              <li key={`${finding.schemaPath}-${index}`} className="break-all">
                {finding.schemaPath || "(no schema path)"}: {finding.message}
              </li>
            ))}
          </ul>
        ) : null}
        <pre className={`${codeBlock} mt-4`} tabIndex={0} aria-label="Raw validation evidence">
          {evidence.technicalJson}
        </pre>
      </div>
    </details>
  );
}

function PinnedSpec({ spec }: { spec: SpecPanelView }) {
  if (spec.kind === "none") {
    return <p className="text-base leading-relaxed text-st-muted">{spec.reason}</p>;
  }
  return (
    <div>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-st-muted">Name</dt>
          <dd className="mt-1 text-base">{spec.name}</dd>
        </div>
        <Meta label="Version">{spec.version}</Meta>
        <Meta label="OpenAPI version">{spec.openApiVersion}</Meta>
        <Meta label="Source file">{spec.sourceFilename}</Meta>
        <div className="sm:col-span-2">
          <Meta label="Revision ID">{spec.id}</Meta>
        </div>
        <div className="sm:col-span-2">
          <Meta label="SHA-256">
            <span className="break-all">{spec.sourceSha256}</span>
          </Meta>
        </div>
      </dl>
      <ul className="mt-4 flex flex-col gap-1 text-sm leading-relaxed text-st-muted">
        <li>
          {spec.isCurrentlyActive
            ? "This revision is still the active spec for its API."
            : "This revision is no longer the active spec. The incident stays pinned to it."}
        </li>
        <li>
          {spec.evidenceChecksum === "matches"
            ? "The checksum recorded with the evidence matches this revision."
            : spec.evidenceChecksum === "differs"
              ? "The checksum recorded with the evidence does not match this revision. Treat this evidence with caution."
              : "No checksum was recorded with this incident's evidence."}
        </li>
      </ul>
    </div>
  );
}

export function evidenceInput(incident: IncidentDetailView): EvidenceProgramInput {
  const explanationParts = [
    incident.explanation.state === "stored"
      ? incident.explanation.text ?? incident.explanation.heading
      : incident.explanation.heading,
    incident.explanation.state !== "stored" ? incident.explanation.text : null,
    incident.explanation.reasonCode ? `Reason code: ${incident.explanation.reasonCode}` : null,
    incident.evidence.format === "none"
      ? `No validation evidence has been stored yet. Result: ${incident.validationLabel}.`
      : null,
    incident.evidence.format === "unrecognized"
      ? "Evidence is stored in a format this screen does not summarize field by field. The raw record is under technical details."
      : null,
    incident.evidence.findings.length === 0 &&
    incident.evidence.format !== "none" &&
    incident.evidence.format !== "unrecognized"
      ? `No schema findings were recorded. Result: ${incident.validationLabel}.`
      : null,
    incident.evidence.unreadableFindings > 0
      ? `${incident.evidence.unreadableFindings} recorded ${
          incident.evidence.unreadableFindings === 1 ? "finding was" : "findings were"
        } unreadable and ${incident.evidence.unreadableFindings === 1 ? "is" : "are"} not shown.`
      : null,
  ].filter((part): part is string => Boolean(part));
  return {
    method: incident.httpMethod,
    path: incident.requestPath,
    statusCode: String(incident.statusCode),
    validationLabel: incident.validationLabel,
    explanation: explanationParts.join("\n"),
    findings: incident.evidence.findings.map((finding) => ({
      path: finding.pathNote ? `${finding.path} (${finding.pathNote})` : finding.path,
      rule: finding.rule,
      expected: finding.expected,
      received: finding.received,
    })),
    specName: incident.spec.kind === "pinned" ? incident.spec.name : "No pinned spec",
    specVersion: incident.spec.kind === "pinned" ? incident.spec.version : "",
  };
}

export function IncidentDetail({
  incident,
  aiExplanation,
}: {
  incident: IncidentDetailView;
  aiExplanation?: IncidentAiExplanationView | null;
}) {
  const summary = evidenceInput(incident);
  return (
    <article aria-labelledby="detail-heading">
      <header className="px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge category={incident.category} label={incident.categoryLabel} />
          <span className="text-sm text-st-muted">{incident.workflowLabel}</span>
        </div>
        <h2 id="detail-heading" className="mt-4 flex min-w-0 flex-wrap items-baseline gap-2">
          <MethodMark method={incident.httpMethod} />
          <span className="min-w-0 font-mono text-lg font-semibold [overflow-wrap:anywhere]">{incident.requestPath}</span>
        </h2>
        <p className="mt-3 text-base">
          <span className="font-mono">{incident.statusCode}</span>
          <span className="text-st-muted"> · </span>
          {incident.validationLabel}
        </p>
        {incident.processingError ? (
          <p className="mt-4 text-base text-error">
            The check recorded an error
            {incident.processingError.code ? ` (${incident.processingError.code})` : ""}.
            {incident.processingError.message ? ` ${incident.processingError.message}` : ""}
          </p>
        ) : null}
      </header>

      <Section title="Stored summary">
        <OpenUiEvidence program={buildIncidentProgram(summary)} input={summary} />
        {incident.evidence.scopeNote ? (
          <p className="mt-4 text-sm leading-relaxed text-st-muted">{incident.evidence.scopeNote}</p>
        ) : null}
        <TechnicalDetails evidence={incident.evidence} />
      </Section>

      {aiExplanation ? <AiExplanationSection view={aiExplanation} /> : null}

      <Section
        title="Sanitized request"
        aside={
          incident.body.kind === "json" ? (
            <CopyTextButton text={incident.body.text} label="Copy sanitized request body" />
          ) : null
        }
      >
        <RequestBody body={incident.body} />
        <RedactionNote format={incident.evidence.format} redactedPaths={incident.evidence.redactedPaths} />
      </Section>

      <Section id="synthetic-test" title="Synthetic test">
        <SandboxTester
          key={incident.id}
          proposalsAvailable={process.env.NODE_ENV === "development" && /^(true|1|on)$/i.test(process.env.SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED ?? "") && Boolean(process.env.THESYS_API_KEY?.trim())}
          incidentId={incident.id}
          method={incident.httpMethod}
          path={incident.requestPath}
          initialText={incident.body.kind === "json" && !incident.body.isJsonNull ? incident.body.text : "{\n}"}
        />
      </Section>

      <Section title="Checked specification">
        <PinnedSpec spec={incident.spec} />
        <dl className="mt-6 grid gap-4 border-t border-base-300 pt-4 sm:grid-cols-2">
          <Meta label="Incident ID">{incident.id}</Meta>
          <Meta label="API key">{incident.apiKey}</Meta>
          <Meta label="Received">{incident.receivedAt}</Meta>
          <Meta label="Checked">
            {incident.checkedAt ?? (incident.category === "pending" ? "Not checked yet" : "Time not recorded")}
          </Meta>
          <Meta label="Occurred">{incident.occurredAt}</Meta>
          <Meta label="Source">{incident.source}</Meta>
        </dl>
      </Section>
    </article>
  );
}

export function DetailPlaceholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-5 sm:px-6">
      <h2 id="detail-heading" className="text-base font-semibold">
        {title}
      </h2>
      {children ? <div className="text-base leading-relaxed text-st-muted">{children}</div> : null}
    </div>
  );
}
