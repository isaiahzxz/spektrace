"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useRef } from "react";
import { focusRing, inset, primaryAction } from "@/components/dashboard/styles";
import { approveTestedCorrection, runSyntheticTest, requestPayloadProposal } from "@/server/dashboard/synthetic-test";
import type { CandidateCheck } from "@/server/review/correction";
import type { PayloadProposalResult } from "@/server/review/payload-proposal";
import { proposalReviewMessage } from "@/lib/payload-proposal/review-message";
import { PayloadDiff } from "@/components/dashboard/payload-diff";

export function SandboxTester({
  incidentId,
  initialText,
  method,
  path,
  proposalsAvailable = false,
}: {
  incidentId: string;
  initialText: string;
  method: string;
  path: string;
  proposalsAvailable?: boolean;
}) {
  const router = useRouter();
  const [candidate, setCandidate] = useState(initialText);
  const [revision, setRevision] = useState<"active" | "pinned">("active");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CandidateCheck | null>(null);
  const [testedText, setTestedText] = useState<string | null>(null);
  const [testedRevision, setTestedRevision] = useState<"active" | "pinned" | null>(null);
  const [proposal, setProposal] = useState<PayloadProposalResult | null>(null);
  const [preparing, setPreparing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const propose = async () => {
    setPreparing(true);
    try {
      const next = await requestPayloadProposal({ incidentId });
      if (mounted.current) setProposal(next);
    } catch { if (mounted.current) setProposal({ status: "unavailable", code: "PROPOSAL_FAILED" }); }
    finally { if (mounted.current) setPreparing(false); }
  };

  const stale = result !== null && (testedText !== candidate || testedRevision !== revision);

  useEffect(() => {
    if (window.location.hash !== "#synthetic-test") return;
    const field = document.getElementById("sandbox-candidate");
    field?.scrollIntoView({ block: "center" });
    if (field instanceof HTMLTextAreaElement) field.focus();
  }, [incidentId]);

  const [decision, setDecision] = useState<string | null>(null);

  const accept = async () => {
    setPending(true);
    try {
      const next = await approveTestedCorrection({ incidentId, candidateText: candidate, revision });
      setDecision(next.detail);
      if (next.ok) router.refresh();
    } catch {
      setDecision("The acceptance could not be completed.");
    } finally {
      setPending(false);
    }
  };

  const run = async () => {
    setPending(true);
    try {
      const next = await runSyntheticTest({ incidentId, candidateText: candidate, revision });
      setResult(next);
      setTestedText(candidate);
      setTestedRevision(revision);
      setDecision(null);
    } catch {
      setResult({
        ok: false,
        label: "Technical failure",
        detail: "The synthetic test could not be completed.",
        eligible: false,
        candidateSha256: null,
        specId: null,
        specLabel: null,
      });
      setTestedText(candidate);
      setTestedRevision(revision);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-sm">
        {method} {path}
      </p>
      <p className="text-sm text-st-muted">
        This checks a candidate against a specification. It does not call the customer API or replace the stored request.
      </p>
      <button type="button" className={`min-h-11 rounded-md border border-base-300 px-3 text-sm ${focusRing}`} disabled={!proposalsAvailable || pending || preparing} onClick={propose}>
        {preparing ? "Preparing proposal" : "Ask for a payload proposal"}
      </button>
      {!proposalsAvailable ? <p className="text-xs text-st-muted">Payload proposals are unavailable in this local pilot. Manual candidate testing remains available.</p> : null}
      <div aria-live="polite">
        {proposal?.status === "ready" ? (
          <div className="rounded-md border border-base-300 p-3">
            <p className="text-sm font-medium">Proposed candidate · human review required</p>
            <p className="mt-1 text-sm text-st-muted">One lossless type conversion at {proposal.jsonPointer}. The pinned body check passed; business correctness and the HTTP failure cause remain unverified.</p>
            <p className="mt-1 text-xs text-st-muted">Plan selected by {proposal.provider} · {proposal.model}. Candidate assembled and checked locally.</p>
            {candidate !== proposal.candidateText ? <div className="mt-3"><PayloadDiff originalText={initialText} candidateText={proposal.candidateText} title="Proposed changes" /></div> : null}
            <details className="mt-2 text-xs text-st-muted"><summary>Source fingerprints</summary><p className="mt-1 break-all">Stored body: {proposal.sourceBodySha256}<br />Pinned revision: {proposal.pinnedSpecId}<br />Specification: {proposal.pinnedSpecSha256}<br />Candidate: {proposal.candidateSha256}</p></details>
            <button type="button" className={`mt-3 ${primaryAction}`} disabled={pending || preparing} onClick={() => { setCandidate(proposal.candidateText); setRevision("pinned"); setResult(null); setTestedText(null); setTestedRevision(null); setDecision(null); }}>
              Replace candidate with this proposal
            </button>
            <p className="mt-2 text-xs text-st-muted">Review the candidate and run its test before making a separate acceptance decision.</p>
          </div>
        ) : proposal ? <p className="text-sm text-st-muted">{proposalReviewMessage(proposal.code)}</p> : null}
      </div>
      <label className="text-sm" htmlFor="sandbox-revision">
        Specification revision
      </label>
      <select
        id="sandbox-revision"
        className={`min-h-11 rounded-md border border-base-300 bg-base-200 px-3 text-sm ${focusRing}`}
        value={revision}
        onChange={(event) => setRevision(event.target.value === "pinned" ? "pinned" : "active")}
      >
        <option value="active">Current active specification</option>
        <option value="pinned">Revision pinned to this incident</option>
      </select>
      <PayloadDiff originalText={initialText} candidateText={candidate} />
      <label className="text-sm" htmlFor="sandbox-candidate">
        Candidate payload
      </label>
      <textarea
        id="sandbox-candidate"
        className={`min-h-40 w-full p-3 font-mono text-sm ${inset} ${focusRing}`}
        value={candidate}
        spellCheck={false}
        onChange={(event) => setCandidate(event.target.value)}
      />
      <button type="button" className={primaryAction} disabled={pending || preparing} onClick={run}>
        {pending ? "Running test" : "Run Test"}
      </button>
      {result ? (
        <div className={`rounded-md border border-base-300 p-3 ${stale ? "opacity-70" : ""}`}>
          <p className="text-xs font-medium tracking-normal text-st-muted">Synthetic test</p>
          <p className={`mt-1 text-sm font-medium ${result.ok ? "text-base-content" : "text-error"}`}>{result.label}</p>
          <p className="mt-1 text-sm leading-relaxed">{result.detail}</p>
          {stale ? (
            <p className="mt-2 text-sm text-st-muted">This result is stale. Run the test again before treating it as current.</p>
          ) : null}
          {result.eligible && !stale ? (
            <div className="mt-3">
              <p id="sandbox-accept-caveat" className="mb-3 text-sm font-medium leading-relaxed">Passing schema check does not guarantee backend/business correctness. It does not explain the original HTTP failure.</p>
              <button type="button" aria-describedby="sandbox-accept-caveat" className={primaryAction} disabled={pending || preparing} onClick={accept}>
                Accept tested correction
              </button>
            </div>
          ) : null}
          {decision ? <p className="mt-2 text-sm">{decision}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
