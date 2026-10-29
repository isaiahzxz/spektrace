import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clientLabel, operationTemplate, protectedBody, protectedSenderReference, senderAlias, type SenderReference } from "./protection";
export type { SenderReference } from "./protection";
import { deliver } from "./transport";

export interface MonitoringRequest extends IncomingMessage { body?: unknown }
export interface ClientAttribution {
  applicationName?: string; applicationVersion?: string; platform?: string; sdkName?: string; sdkVersion?: string;
}
export interface MonitoringOptions {
  baseUrl: string;
  ingestionToken: string;
  apiKey: string;
  environment?: string;
  operationPath?: string | ((request: MonitoringRequest) => string | undefined);
  captureSanitizedBody?: (request: MonitoringRequest) => unknown;
  client?: ClientAttribution;
  resolveAuthenticatedSender?: (request: MonitoringRequest) => SenderReference | undefined;
  maxPending?: number;
  concurrency?: number;
  timeoutMs?: number;
}
export interface MonitoringStats {
  captured: number; delivered: number; failed: number; timedOut: number;
  queueFull: number; bodyOmitted: number; operationUnresolved: number; captureFailed: number; shutdownDropped: number;
  pending: number; closed: boolean;
  senderOmitted: number;
}
export interface ExpressMonitor {
  middleware(request: MonitoringRequest, response: ServerResponse, next: () => void): void;
  operation(template: string): (request: MonitoringRequest, response: ServerResponse, next: () => void) => void;
  flush(timeoutMs?: number): Promise<boolean>;
  close(): void;
  stats(): MonitoringStats;
}

const observedResponses = new WeakSet<ServerResponse>();
const headers = [
  ["x-spektrace-application", "applicationName"], ["x-spektrace-application-version", "applicationVersion"],
  ["x-spektrace-platform", "platform"], ["x-spektrace-sdk", "sdkName"], ["x-spektrace-sdk-version", "sdkVersion"],
] as const;

function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error("Invalid monitoring limits");
  return value;
}

export function createExpressMonitor(options: MonitoringOptions): ExpressMonitor {
  let origin: URL;
  try { origin = new URL(options.baseUrl); } catch { throw new Error("Invalid monitoring endpoint"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("Invalid monitoring endpoint");
  if (!/^st_ingest_v1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(options.ingestionToken) || /\s/.test(options.ingestionToken)) throw new Error("Invalid ingestion credential");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.apiKey)) throw new Error("Invalid monitoring service");
  const environment = options.environment ?? "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(environment)) throw new Error("Invalid monitoring environment");
  if (typeof options.operationPath === "string" && !operationTemplate(options.operationPath)) throw new Error("Invalid operation template");
  const maxPending = bounded(options.maxPending, 64, 256);
  const concurrency = bounded(options.concurrency, 2, 8);
  const timeoutMs = bounded(options.timeoutMs, 2000, 5000);
  const endpoint = new URL("/api/internal/incidents", origin);
  const staticClient: ClientAttribution = {};
  for (const [, field] of headers) {
    if (options.client?.[field] === undefined) continue;
    const label = clientLabel(options.client[field]);
    if (!label) throw new Error("Invalid monitoring client identity");
    staticClient[field] = label;
  }
  const token = options.ingestionToken;
  const apiKey = options.apiKey;
  const operation = options.operationPath;
  const bodyCallback = options.captureSanitizedBody;
  const senderCallback = options.resolveAuthenticatedSender;
  if (senderCallback !== undefined && typeof senderCallback !== "function") throw new Error("Invalid sender resolver");
  const counters = { captured: 0, delivered: 0, failed: 0, timedOut: 0, queueFull: 0, bodyOmitted: 0, operationUnresolved: 0, captureFailed: 0, shutdownDropped: 0, senderOmitted: 0 };
  const queue: string[] = [];
  const operationHints = new WeakMap<IncomingMessage, string>();
  const active = new Set<AbortController>();
  const waiters = new Set<() => void>();
  let preparing = 0;
  let closed = false;
  const pending = () => preparing + queue.length + active.size;
  const notify = () => { if (pending() === 0) for (const done of [...waiters]) done(); };

  function pump() {
    while (!closed && queue.length && active.size < concurrency) {
      const payload = queue.shift();
      if (payload === undefined) break;
      const controller = new AbortController(); active.add(controller);
      void deliver(endpoint, token, payload, timeoutMs, controller.signal).then((result) => {
        if (!closed && result !== "closed") counters[result]++;
      }).catch(() => { if (!closed) counters.failed++; }).finally(() => {
        active.delete(controller); pump(); notify();
      });
    }
  }

  return {
    operation(template) {
      const path = operationTemplate(template);
      if (!path) throw new Error("Invalid operation template");
      return (request, _response, next) => { operationHints.set(request, path); next(); };
    },
    middleware(request, response, next) {
      if (closed || observedResponses.has(response)) { next(); return; }
      observedResponses.add(response);
      const occurredAt = new Date().toISOString();
      const finish = () => {
        response.removeListener("close", cleanup);
        if (closed || response.statusCode < 400 || response.statusCode > 499) return;
        if (pending() >= maxPending) { counters.queueFull++; return; }
        preparing++;
        try {
          const resolved: unknown = operationHints.get(request) ?? (typeof operation === "function" ? operation(request) : operation);
          if (resolved instanceof Promise) void resolved.catch(() => {});
          const path = operationTemplate(resolved);
          if (!path) counters.operationUnresolved++;
          const client: ClientAttribution = { ...staticClient };
          for (const [header, field] of headers) {
            if (client[field]) continue;
            // A duplicate custom header is ambiguous even if Node joins it into a string.
            let occurrences = 0;
            for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === header) occurrences++;
            const value = occurrences <= 1 ? clientLabel(request.headers[header]) : undefined;
            if (value) client[field] = value;
          }
          let body: unknown;
          let senderReference: SenderReference | undefined;
          if (senderCallback) {
            try { senderReference = protectedSenderReference(senderCallback(request)); }
            catch { counters.senderOmitted++; }
          }
          let clientHeaderCount = 0;
          for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === "x-client-id") clientHeaderCount++;
          const reportedClientRef = clientHeaderCount === 1 ? senderAlias(request.headers["x-client-id"]) : undefined;
          if (clientHeaderCount > 0 && !reportedClientRef) counters.senderOmitted++;
          if (bodyCallback && path) {
            try { body = protectedBody(bodyCallback(request)); } catch { counters.bodyOmitted++; }
          } else if (bodyCallback) counters.bodyOmitted++;
          const payload = JSON.stringify({ source: "WEBHOOK", sourceEventId: `express-${randomUUID()}`, apiKey, environment,
            httpMethod: request.method?.toUpperCase() ?? "UNKNOWN", requestPath: path ?? "/__unresolved_operation__",
            statusCode: response.statusCode, occurredAt, client,
            ...(senderReference ? { senderReference } : {}),
            ...(reportedClientRef ? { reportedClientRef } : {}),
            ...(body === undefined ? {} : { sanitizedRequestBody: body }),
          });
          if (closed) return;
          if (Buffer.byteLength(payload, "utf8") > 65_536) { counters.captureFailed++; return; }
          queue.push(payload); counters.captured++;
          setImmediate(pump).unref();
        } catch { counters.captureFailed++; }
        finally { preparing--; notify(); }
      };
      const cleanup = () => { response.removeListener("finish", finish); };
      response.once("finish", finish);
      response.once("close", cleanup);
      next();
    },
    flush(deadline = 3000) {
      bounded(deadline, 3000, 10_000);
      if (pending() === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const done = () => { clearTimeout(timer); waiters.delete(done); resolve(true); };
        const timer = setTimeout(() => { waiters.delete(done); resolve(false); }, deadline);
        waiters.add(done); pump();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      counters.shutdownDropped += preparing + queue.length + active.size;
      queue.length = 0;
      for (const controller of active) controller.abort();
      notify();
    },
    stats() { return { ...counters, pending: pending(), closed }; },
  };
}
