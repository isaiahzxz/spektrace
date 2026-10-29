import { z } from "zod";
import { AGENT_EVIDENCE_VERSION } from "@/lib/agent-evidence/agent-evidence-v1";

export const PROTECTED_GROUP_EVIDENCE_SUMMARY_VERSION = 1;

const incidentRefSchema = z.object({
  incidentId: z.string().uuid(),
  bundleVersion: z.literal(AGENT_EVIDENCE_VERSION),
});

export const protectedGroupEvidenceSummarySchema = z.object({
  version: z.literal(PROTECTED_GROUP_EVIDENCE_SUMMARY_VERSION),
  membershipVersion: z.number().int().min(0),
  includedIncidentCount: z.number().int().min(0),
  omittedIncidentCount: z.number().int().min(0),
  evidenceFormatVersion: z.literal(AGENT_EVIDENCE_VERSION),
  builderVersion: z.string().min(1).max(128),
  /** Incident ids included in this preparation run (no request bodies). */
  includedIncidents: z.array(incidentRefSchema).max(50),
  /**
   * Stage 2 stops at protected evidence preparation. No AI investigation output is stored here.
   */
  aiInvestigationPerformed: z.literal(false),
});

export type ProtectedGroupEvidenceSummaryV1 = z.infer<
  typeof protectedGroupEvidenceSummarySchema
>;
