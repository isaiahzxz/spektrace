import type { GatewayErrorDiagnosticsV1 } from "@/lib/investigation/inference/adapters/gateway-error-diagnostics";
import type { InvestigationModelInput } from "@/lib/investigation/inference/rebuild-inference-input";

export type InferenceUsageMetadata = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type InferenceAdapterResult =
  | {
      ok: true;
      rawJson: unknown;
      provider: string;
      model: string;
      usage?: InferenceUsageMetadata;
      outputContract?: "source-facts-v2";
    }
  | { ok: false; code: string; retryable: boolean; diagnostics?: GatewayErrorDiagnosticsV1 };

export type InvestigationInferenceAdapter = {
  kind: "test" | "gateway" | "none";
  providerLabel: string;
  modelLabel: string;
  complete(input: InvestigationModelInput): Promise<InferenceAdapterResult>;
};
