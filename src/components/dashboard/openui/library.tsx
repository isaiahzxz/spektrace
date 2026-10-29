"use client";

import { createLibrary, defineComponent } from "@openuidev/react-lang";
import { z } from "zod/v4";

const IncidentSummary = defineComponent({
  name: "IncidentSummary",
  description: "Method, route, status code, and check result for one stored incident.",
  props: z.object({
    method: z.string(),
    path: z.string(),
    statusCode: z.string(),
    validationLabel: z.string(),
  }),
  component: ({ props }) => (
    <div>
      <p className="font-mono text-sm text-st-muted">
        <span>{props.method}</span>
        <span> {props.path}</span>
      </p>
      <p className="mt-2 text-base">
        <span className="font-mono tabular-nums">{props.statusCode}</span>
        <span className="text-st-muted"> · </span>
        {props.validationLabel}
      </p>
    </div>
  ),
});

const StoredExplanation = defineComponent({
  name: "StoredExplanation",
  description: "Plain-English explanation saved with the incident.",
  props: z.object({
    text: z.string(),
  }),
  component: ({ props }) => <p className="text-base leading-relaxed">{props.text}</p>,
});

const FindingList = defineComponent({
  name: "FindingList",
  description: "Expected and received values from the stored check.",
  props: z.object({
    rows: z.array(z.string()),
  }),
  component: ({ props }) =>
    props.rows.length === 0 ? (
      <p className="text-sm text-st-muted">No field comparison was stored for this check.</p>
    ) : (
      <ul className="flex flex-col gap-3">
        {props.rows.map((row) => (
          <li key={row} className="font-mono text-sm leading-relaxed [overflow-wrap:anywhere]">
            {row}
          </li>
        ))}
      </ul>
    ),
});

const SpecReference = defineComponent({
  name: "SpecReference",
  description: "Name and version of the specification pinned to the incident.",
  props: z.object({
    name: z.string(),
    version: z.string(),
  }),
  component: ({ props }) => (
    <p className="text-sm">
      <span>{props.name}</span>
      {props.version ? <span className="font-mono text-st-muted"> {props.version}</span> : null}
    </p>
  ),
});

const IncidentEvidence = defineComponent({
  name: "IncidentEvidence",
  description: "Read-only summary of one stored incident.",
  props: z.object({
    summary: IncidentSummary.ref,
    explanation: StoredExplanation.ref,
    findings: FindingList.ref,
    spec: SpecReference.ref,
  }),
  component: ({ props, renderNode }) => (
    <div className="flex flex-col gap-6">
      <div>{renderNode(props.summary)}</div>
      <div>
        <h3 className="text-sm font-medium">What happened</h3>
        <div className="mt-2">{renderNode(props.explanation)}</div>
      </div>
      <div>
        <h3 className="text-sm font-medium">Expected and received</h3>
        <div className="mt-2">{renderNode(props.findings)}</div>
      </div>
      <div>
        <h3 className="text-sm font-medium">Specification</h3>
        <div className="mt-2">{renderNode(props.spec)}</div>
      </div>
    </div>
  ),
});

const CompactEvidence = defineComponent({
  name: "CompactEvidence",
  description: "Short identity, finding, and expected-versus-received line for the overview.",
  props: z.object({
    incidentId: z.string(),
    summary: IncidentSummary.ref,
    findings: FindingList.ref,
  }),
  component: ({ props, renderNode }) => (
    <div className="flex flex-col gap-0.5 [&_li]:text-xs [&_li]:leading-5 [&_p]:mt-0 [&_p]:text-xs [&_ul]:mt-0.5">
      <p className="font-mono text-xs text-st-muted">{props.incidentId}</p>
      {renderNode(props.summary)}
      <h3 className="sr-only">Expected and received</h3>
      {renderNode(props.findings)}
    </div>
  ),
});

export const incidentLibrary = createLibrary({
  components: [IncidentSummary, StoredExplanation, FindingList, SpecReference, IncidentEvidence],
  root: "IncidentEvidence",
});

export const compactIncidentLibrary = createLibrary({
  components: [IncidentSummary, FindingList, CompactEvidence],
  root: "CompactEvidence",
});
