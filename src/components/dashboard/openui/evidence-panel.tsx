"use client";

import { Component, type ReactNode, useMemo, useState } from "react";
import { Renderer, createParser } from "@openuidev/react-lang";
import { compactIncidentLibrary, incidentLibrary } from "@/components/dashboard/openui/library";
import type { EvidenceProgramInput } from "@/lib/openui/incident-program";

const parser = createParser(incidentLibrary.toJSONSchema(), incidentLibrary.root);
const compactParser = createParser(compactIncidentLibrary.toJSONSchema(), compactIncidentLibrary.root);

class RenderBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function SavedEvidence({ input, compact }: { input: EvidenceProgramInput; compact: boolean }) {
  if (compact) {
    const [first, ...rest] = input.findings;
    const line = first
      ? `${first.path} | ${first.rule} | expected ${first.expected} | received ${first.received}${rest.length > 0 ? ` · ${rest.length} more stored comparisons` : ""}`
      : "No field comparison was stored for this check.";
    return (
      <div className="flex flex-col gap-0.5">
        <p className="font-mono text-xs text-st-muted">
          {input.method} {input.path}
        </p>
        <p className="text-xs">
          <span className="font-mono tabular-nums">{input.statusCode}</span>
          <span className="text-st-muted"> · </span>
          {input.validationLabel}
        </p>
        <p className="font-mono text-xs leading-5 [overflow-wrap:anywhere]">{line}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-st-muted">
        The formatted summary could not be rendered. This is the same saved record.
      </p>
      <div>
        <p className="font-mono text-sm text-st-muted">
          {input.method} {input.path}
        </p>
        <p className="mt-2 text-base">
          <span className="font-mono tabular-nums">{input.statusCode}</span>
          <span className="text-st-muted"> · </span>
          {input.validationLabel}
        </p>
      </div>
      {compact ? null : (
      <div>
        <h3 className="text-sm font-medium">What happened</h3>
        <p className="mt-2 text-base leading-relaxed">{input.explanation}</p>
      </div>
      )}
      <div>
        <h3 className="text-sm font-medium">Expected and received</h3>
        {input.findings.length === 0 ? (
          <p className="mt-2 text-sm text-st-muted">No field comparison was stored for this check.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3">
            {input.findings.map((finding) => (
              <li
                key={`${finding.path}-${finding.expected}-${finding.received}`}
                className="font-mono text-sm leading-relaxed [overflow-wrap:anywhere]"
              >
                {finding.path} | {finding.rule} | expected {finding.expected} | received {finding.received}
              </li>
            ))}
          </ul>
        )}
      </div>
      {compact ? null : (
      <div>
        <h3 className="text-sm font-medium">Specification</h3>
        <p className="mt-2 text-sm">
          {input.specName}
          {input.specVersion ? <span className="font-mono text-st-muted"> {input.specVersion}</span> : null}
        </p>
      </div>
      )}
    </div>
  );
}

export function OpenUiEvidence({
  program,
  input,
  presentation = "full",
}: {
  program: string;
  input: EvidenceProgramInput;
  presentation?: "full" | "compact";
}) {
  const compact = presentation === "compact";
  const activeParser = compact ? compactParser : parser;
  const library = compact ? compactIncidentLibrary : incidentLibrary;
  const invalid = useMemo(() => activeParser.parse(program).meta.errors.length > 0, [activeParser, program]);
  const [renderFailed, setRenderFailed] = useState(false);
  const fallback = <SavedEvidence input={input} compact={compact} />;

  if (invalid || renderFailed) return fallback;

  return (
    <RenderBoundary fallback={fallback}>
      <Renderer
        response={program}
        library={library}
        isStreaming={false}
        queryLoader={null}
        onError={(errors) => {
          if (errors.length > 0) setRenderFailed(true);
        }}
      />
    </RenderBoundary>
  );
}
