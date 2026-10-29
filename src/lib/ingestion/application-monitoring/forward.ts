import { buildApplicationMonitoringEnvelope } from "@/lib/ingestion/application-monitoring/build-envelope";
import type {
  ApplicationHttpFailureEvent,
  ApplicationMonitoringHttpConfig,
  ApplicationMonitoringScope,
  ForwardApplicationFailureResult,
} from "@/lib/ingestion/application-monitoring/types";

export async function forwardApplicationHttpFailure(
  config: ApplicationMonitoringHttpConfig,
  scope: ApplicationMonitoringScope,
  failure: ApplicationHttpFailureEvent,
  options?: { fetchImpl?: typeof fetch },
): Promise<ForwardApplicationFailureResult> {
  const built = buildApplicationMonitoringEnvelope(failure, scope);
  if (!built.ok) {
    return { ok: false, code: built.code, message: built.message };
  }

  const fetchFn = options?.fetchImpl ?? fetch;
  const base = config.baseUrl.replace(/\/$/, "");
  const response = await fetchFn(`${base}/api/internal/incidents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(built.envelope),
  });

  let payload: { id?: string; error?: string } | null = null;
  try {
    payload = (await response.json()) as { id?: string; error?: string };
  } catch {
    payload = null;
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: "APPMON_INGEST_UNAUTHORIZED",
      httpStatus: response.status,
      message: "Ingestion credentials were rejected.",
    };
  }

  if (response.status === 409) {
    return {
      ok: false,
      code: "APPMON_INGEST_CONFLICT",
      httpStatus: response.status,
      message: "Duplicate source event id with conflicting payload.",
    };
  }

  if (!response.ok || !payload?.id) {
    return {
      ok: false,
      code: "APPMON_INGEST_FAILED",
      httpStatus: response.status,
      message: payload?.error ?? "Incident ingestion failed.",
    };
  }

  return {
    ok: true,
    httpStatus: response.status,
    incidentId: payload.id,
    created: response.status === 202,
    deduplicated: response.status === 200,
  };
}
