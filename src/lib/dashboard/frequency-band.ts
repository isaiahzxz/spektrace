export type FrequencyBand = "low" | "medium" | "high";

/**
 * Initial product thresholds for how often a mismatch pattern appears.
 * They are not a statistical model and they do not measure business impact.
 * 1–4 low, 5–19 medium, 20 or more high.
 */
export function frequencyBand(count: number): FrequencyBand {
  if (count >= 20) return "high";
  if (count >= 5) return "medium";
  return "low";
}

export const FREQUENCY_BAND_LABEL: Record<FrequencyBand, string> = {
  low: "Low frequency",
  medium: "Medium frequency",
  high: "High frequency",
};
