import { getHarnessInferenceAdapter } from "@/lib/investigation/inference/adapters/harness-inference-slot";
import { createGatewayInferenceAdapter } from "@/lib/investigation/inference/adapters/gateway-adapter";
import { createTestInferenceAdapter } from "@/lib/investigation/inference/adapters/test-adapter";
import type { InvestigationInferenceAdapter } from "@/lib/investigation/inference/adapters/types";
import {
  resolveInferenceAdapterKind,
  type InferenceAdapterKind,
} from "@/lib/investigation/inference/config";

const noneAdapter: InvestigationInferenceAdapter = {
  kind: "none",
  providerLabel: "none",
  modelLabel: "not-configured",
  async complete() {
    return { ok: false, code: "INFERENCE_NOT_CONFIGURED", retryable: false };
  },
};

export function resolveInvestigationInferenceAdapter(): {
  adapter: InvestigationInferenceAdapter;
  kind: InferenceAdapterKind;
} {
  const harness = getHarnessInferenceAdapter();
  if (harness) {
    return { kind: harness.kind, adapter: harness };
  }

  const kind = resolveInferenceAdapterKind();
  if (kind === "test") {
    return { kind, adapter: createTestInferenceAdapter() };
  }
  if (kind === "gateway") {
    return { kind, adapter: createGatewayInferenceAdapter() };
  }
  return { kind, adapter: noneAdapter };
}
