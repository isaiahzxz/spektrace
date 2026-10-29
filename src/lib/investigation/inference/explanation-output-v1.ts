import { z } from "zod";
import { INVESTIGATION_INFERENCE_LIMITS } from "@/lib/investigation/inference/config";

const shortText = z.string().min(1).max(2_000);
const stepText = z.string().min(1).max(1_000);
const citationId = z.string().regex(/^(?:ev-[a-z0-9]{6,12}|rx-[a-z0-9]{6,12}|dx-[a-z0-9]{6,12}|dp-[a-z0-9]{6,12})$/)
  .describe("Use an exact ID supplied in the evidence: ev- for incident validation, rx- for repository, dx- for documentation, dp- for deployment. Match the cited source to the fact; these prefixes are not interchangeable.");

export const investigationExplanationOutputSchema = z
  .object({
    summary: shortText.max(INVESTIGATION_INFERENCE_LIMITS.maxSummaryChars),
    observedFindings: z
      .array(
        z
          .object({
            description: shortText,
            citationIds: z.array(citationId).min(1).max(INVESTIGATION_INFERENCE_LIMITS.maxCitationIdsPerItem),
          })
          .strict(),
      )
      .max(INVESTIGATION_INFERENCE_LIMITS.maxListItems),
    evidenceCitations: z
      .array(
        z
          .object({
            id: citationId,
            label: z.string().min(1).max(512),
          })
          .strict(),
      )
      .max(INVESTIGATION_INFERENCE_LIMITS.maxListItems),
    hypotheses: z
      .array(
        z
          .object({
            label: z.string().min(1).max(128),
            description: shortText,
            citationIds: z.array(citationId).max(INVESTIGATION_INFERENCE_LIMITS.maxCitationIdsPerItem),
          })
          .strict(),
      )
      .max(INVESTIGATION_INFERENCE_LIMITS.maxListItems)
      .optional(),
    limitations: z.array(shortText).max(INVESTIGATION_INFERENCE_LIMITS.maxListItems),
    missingContext: z.array(shortText).max(INVESTIGATION_INFERENCE_LIMITS.maxListItems),
    suggestedSteps: z.array(stepText).max(INVESTIGATION_INFERENCE_LIMITS.maxListItems),
  })
  .strict();

export type InvestigationExplanationOutputV1 = z.infer<
  typeof investigationExplanationOutputSchema
>;
