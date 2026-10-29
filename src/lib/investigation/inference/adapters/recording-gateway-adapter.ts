import {
  gatewayBaseUrl,
  gatewayModelId,
  INVESTIGATION_INFERENCE_LIMITS,
} from "@/lib/investigation/inference/config";
import {
  buildEvidenceUserMessage,
  buildTrustedSystemPrompt,
  outputJsonSchemaDescription,
} from "@/lib/investigation/inference/explanation-prompt-v1";
import { validateInferenceInputBeforeProvider } from "@/lib/investigation/inference/rebuild-inference-input";
import { utf8ByteLength } from "@/lib/investigation/inference/utf8-byte-length";
import type {
  InferenceAdapterResult,
  InvestigationInferenceAdapter,
} from "@/lib/investigation/inference/adapters/types";
import { parseGatewayHttpFailure } from "@/lib/investigation/inference/adapters/gateway-error-diagnostics";
import { createTestInferenceAdapter } from "@/lib/investigation/inference/adapters/test-adapter";
import { requiresStructuredSourceExplanation } from "../structured-source-explanation";

export type RecordingGatewayOptions = {
  maxOutboundAttempts: number;
  fetchImpl?: typeof fetch;
  simulateProvider?: boolean;
};

export type RecordingGatewayState = {
  outboundAttempts: number;
  lastValidatedInputUtf8Bytes: number | null;
  transmittedAfterValidation: boolean;
};

export function createRecordingGatewayAdapter(
  options: RecordingGatewayOptions,
): InvestigationInferenceAdapter & { state: RecordingGatewayState } {
  const model = gatewayModelId();
  const state: RecordingGatewayState = {
    outboundAttempts: 0,
    lastValidatedInputUtf8Bytes: null,
    transmittedAfterValidation: false,
  };
  const simulate = options.simulateProvider ?? false;
  const testAdapter = simulate ? createTestInferenceAdapter() : null;

  return {
    kind: "gateway",
    providerLabel: simulate ? "verify-simulated-gateway" : "openui-gateway",
    modelLabel: model,
    state,
    async complete(input) {
      const boundary = validateInferenceInputBeforeProvider(input);
      if (!boundary.ok) {
        return { ok: false, code: boundary.code, retryable: false };
      }
      state.lastValidatedInputUtf8Bytes = jsonUtf8ByteLength(input);

      if (state.outboundAttempts >= options.maxOutboundAttempts) {
        return { ok: false, code: "VERIFY_ATTEMPT_BUDGET_EXCEEDED", retryable: false };
      }

      if (simulate && testAdapter) {
        state.outboundAttempts += 1;
        state.transmittedAfterValidation = true;
        return testAdapter.complete(input);
      }

      const apiKey = process.env.THESYS_API_KEY?.trim();
      if (!apiKey) {
        return { ok: false, code: "GATEWAY_NOT_CONFIGURED", retryable: false };
      }

      const fetchFn = options.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), INVESTIGATION_INFERENCE_LIMITS.providerTimeoutMs);

      try {
        state.outboundAttempts += 1;
        state.transmittedAfterValidation = true;
        const response = await fetchFn(`${gatewayBaseUrl()}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: INVESTIGATION_INFERENCE_LIMITS.maxProviderCompletionTokens,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: `${buildTrustedSystemPrompt(input)}\nRequired JSON shape:\n${outputJsonSchemaDescription(input)}`,
              },
              { role: "user", content: buildEvidenceUserMessage(input) },
            ],
          }),
          signal: controller.signal,
        });

        const result = await parseGatewayResponse(response, model);
        return result.ok && requiresStructuredSourceExplanation(input) ? { ...result, outputContract: "source-facts-v2" } : result;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return { ok: false, code: "GATEWAY_TIMEOUT", retryable: true };
        }
        return { ok: false, code: "GATEWAY_REQUEST_FAILED", retryable: true };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function jsonUtf8ByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}

async function parseGatewayResponse(response: Response, model: string): Promise<InferenceAdapterResult> {
  if (!response.ok) {
    const failure = await parseGatewayHttpFailure(response);
    return {
      ok: false,
      code: failure.failureCode,
      retryable: failure.retryable,
      diagnostics: failure.diagnostics,
    };
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    return { ok: false, code: "GATEWAY_EMPTY_RESPONSE", retryable: true };
  }
  if (utf8ByteLength(content) > INVESTIGATION_INFERENCE_LIMITS.maxOutputUtf8Bytes) {
    return { ok: false, code: "GATEWAY_RESPONSE_SIZE_EXCEEDED", retryable: false };
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(content) as unknown;
  } catch {
    return { ok: false, code: "GATEWAY_NON_JSON", retryable: false };
  }

  return {
    ok: true,
    rawJson,
    provider: "openui-gateway",
    model,
    usage: {
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
      totalTokens: payload.usage?.total_tokens,
    },
  };
}
