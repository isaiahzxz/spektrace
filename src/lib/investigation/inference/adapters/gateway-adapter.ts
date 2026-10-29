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
import { parseGatewayHttpFailure } from "@/lib/investigation/inference/adapters/gateway-error-diagnostics";
import { validateInferenceInputBeforeProvider } from "@/lib/investigation/inference/rebuild-inference-input";
import { utf8ByteLength } from "@/lib/investigation/inference/utf8-byte-length";
import type { InvestigationInferenceAdapter } from "@/lib/investigation/inference/adapters/types";
import { requiresStructuredSourceExplanation } from "../structured-source-explanation";

export function createGatewayInferenceAdapter(): InvestigationInferenceAdapter {
  const model = gatewayModelId();
  return {
    kind: "gateway",
    providerLabel: "openui-gateway",
    modelLabel: model,
    async complete(input) {
      const boundary = validateInferenceInputBeforeProvider(input);
      if (!boundary.ok) {
        return { ok: false, code: boundary.code, retryable: false };
      }

      const apiKey = process.env.THESYS_API_KEY?.trim();
      if (!apiKey) {
        return { ok: false, code: "GATEWAY_NOT_CONFIGURED", retryable: false };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), INVESTIGATION_INFERENCE_LIMITS.providerTimeoutMs);

      try {
        const response = await fetch(`${gatewayBaseUrl()}/chat/completions`, {
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
          ...(requiresStructuredSourceExplanation(input) ? { outputContract: "source-facts-v2" as const } : {}),
          provider: "openui-gateway",
          model,
          usage: {
            promptTokens: payload.usage?.prompt_tokens,
            completionTokens: payload.usage?.completion_tokens,
            totalTokens: payload.usage?.total_tokens,
          },
        };
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
