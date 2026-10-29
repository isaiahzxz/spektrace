"use server";
import { getDashboardWorkspaceId } from "@/server/accounts/workspace";

import { getPrisma } from "@/lib/db";

import { acceptTestedCorrection, evaluateCandidate } from "@/server/review/correction";
import { z } from "zod";
import { generatePayloadProposal, type PayloadProposalResult } from "@/server/review/payload-proposal";
import { createPayloadProposalGateway } from "@/server/review/payload-proposal-gateway";

let proposalRequests = 0;
export async function requestPayloadProposal(input: { incidentId: string }): Promise<PayloadProposalResult> {
  if (process.env.NODE_ENV !== "development" || !/^(true|1|on)$/i.test(process.env.SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED ?? "")) return { status: "unavailable", code: "PROPOSALS_DISABLED" };
  const parsed = z.object({ incidentId: z.string().uuid() }).strict().safeParse(input);
  if (!parsed.success) return { status: "unavailable", code: "INVALID_INCIDENT_REFERENCE" };
  if (!process.env.THESYS_API_KEY?.trim()) return { status: "unavailable", code: "PROPOSAL_NOT_CONFIGURED" };
  if (proposalRequests >= 2) return { status: "unavailable", code: "PROPOSAL_BUSY" };
  proposalRequests += 1;
  try { return await generatePayloadProposal(getPrisma(), (await getDashboardWorkspaceId()), parsed.data.incidentId, createPayloadProposalGateway()); }
  catch { return { status: "unavailable", code: "PROPOSAL_FAILED" }; }
  finally { proposalRequests -= 1; }
}

function unavailable(detail: string) {
  return { ok: false, label: "Unavailable", detail, eligible: false, candidateSha256: null, specId: null, specLabel: null };
}

export async function runSyntheticTest(input: {
  incidentId: string;
  candidateText: string;
  revision: "pinned" | "active";
}) {
  if (process.env.NODE_ENV !== "development") {
    return unavailable("Synthetic tests run only in the local pilot.");
  }
  return evaluateCandidate(getPrisma(), (await getDashboardWorkspaceId()), input);
}

export async function approveTestedCorrection(input: {
  incidentId: string;
  candidateText: string;
  revision: "pinned" | "active";
}) {
  if (process.env.NODE_ENV !== "development") {
    return { ok: false, detail: "Acceptance runs only in the local pilot." };
  }
  return acceptTestedCorrection(getPrisma(), (await getDashboardWorkspaceId()), input);
}
