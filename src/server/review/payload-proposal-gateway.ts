import { gatewayBaseUrl } from "@/lib/investigation/inference/config";
import { scanSerializedBundleForLeaks } from "@/lib/agent-evidence/outbound-scan";
import { proposalInputSchema, type ProposalAdapter } from "@/lib/payload-proposal/contract";
import { inspectProposalResponse, type ProposalResponseDiagnostic } from "@/lib/payload-proposal/response-diagnostics";
import { buildPayloadProposalPrompt } from "@/lib/payload-proposal/prompt";

export function createPayloadProposalGateway(options: { onDiagnostic?: (diagnostic: ProposalResponseDiagnostic) => void } = {}): ProposalAdapter {
  const model = process.env.SPEKTRACE_PAYLOAD_PROPOSAL_MODEL?.trim() || "openai/gpt-4.1";
  return { provider: "openui-gateway", model, async propose(input) {
    const checked = proposalInputSchema.parse(input);
    const body = JSON.stringify({ model, temperature: 0, max_tokens: 256, response_format: { type: "json_object" }, messages: [
      { role: "system", content: buildPayloadProposalPrompt(checked) },
      { role: "user", content: JSON.stringify(checked) },
    ] });
    if (Buffer.byteLength(body, "utf8") > 16_384 || !scanSerializedBundleForLeaks(body).safe) throw new Error("PROPOSAL_EXPORT_BLOCKED");
    const key = process.env.THESYS_API_KEY?.trim();
    if (!key) throw new Error("PROPOSAL_NOT_CONFIGURED");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${gatewayBaseUrl()}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal: controller.signal });
      if (!response.ok) throw new Error("PROPOSAL_GATEWAY_FAILED");
      if (!response.body) throw new Error("PROPOSAL_EMPTY_RESPONSE");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8_192) { await reader.cancel(); throw new Error("PROPOSAL_RESPONSE_TOO_LARGE"); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      const inspected = inspectProposalResponse(text, checked, response.status);
      try { options.onDiagnostic?.(inspected.diagnostic); } catch { /* Diagnostics must not alter proposal validation. */ }
      if (!inspected.ok) throw new Error(inspected.diagnostic.code);
      return inspected.plan;
    } finally { clearTimeout(timeout); }
  } };
}
