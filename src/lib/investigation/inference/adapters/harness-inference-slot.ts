import type { InvestigationInferenceAdapter } from "@/lib/investigation/inference/adapters/types";

let harnessAdapter: InvestigationInferenceAdapter | null = null;

/** Set only during bounded verification runs; cleared before process exit. */
export function setHarnessInferenceAdapter(adapter: InvestigationInferenceAdapter | null): void {
  harnessAdapter = adapter;
}

export function getHarnessInferenceAdapter(): InvestigationInferenceAdapter | null {
  return harnessAdapter;
}
