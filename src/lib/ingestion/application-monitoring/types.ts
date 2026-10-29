import type { ClientAttribution } from "@/lib/ingestion/client-attribution";

/** Bounded HTTP 4xx failure observed by a synthetic application monitor. */
export type ApplicationHttpFailureEvent = {
  sourceEventId: string;
  httpMethod: string;
  requestPath: string;
  statusCode: number;
  occurredAt: string;
  sanitizedRequestBody?: unknown | null;
  clientReference?: string;
  client?: ClientAttribution;
};

export type ApplicationMonitoringScope = {
  apiKey: string;
  environment?: string;
};

export type ApplicationMonitoringHttpConfig = {
  baseUrl: string;
  bearerToken: string;
};

export type ForwardApplicationFailureResult =
  | {
      ok: true;
      httpStatus: number;
      incidentId: string;
      created: boolean;
      deduplicated: boolean;
    }
  | { ok: false; code: string; httpStatus?: number; message: string };
