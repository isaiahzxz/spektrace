export function proposalReviewMessage(code: string): string {
  if (code === "PROPOSALS_DISABLED") return "Payload proposals are not enabled for this local pilot.";
  if (code === "PROPOSAL_NOT_CONFIGURED") return "The proposal provider is not configured.";
  if (code === "PROPOSAL_BUSY") return "Two proposals are already being prepared. Try again after one finishes.";
  if (code === "NO_ELIGIBLE_MISMATCH") return "This incident does not have an eligible unapproved body mismatch.";
  if (code === "NO_LOSSLESS_TRANSFORMATION") return "No unambiguous whole-number conversion is available. Enter the intended value manually; decimals will not be rounded.";
  if (code === "SOURCE_CHANGED_DURING_PROPOSAL") return "The source changed during generation. Discard this result and request a new proposal.";
  if (code === "CANDIDATE_BODY_CHECK_FAILED") return "The candidate did not pass the complete supported body check against the pinned revision. Human input is needed.";
  return "A proposal could not be verified from the available evidence. The stored request and your candidate were left unchanged.";
}
