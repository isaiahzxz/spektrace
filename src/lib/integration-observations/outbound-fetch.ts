import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  captureSchema,
  correlationSchema,
  coverageSchema,
  identitySchema,
  observationSchema,
  operationSchema,
  outcomeSchema,
  pointerSchema,
  type CoverageInput,
  type ObservationInput,
  type OutcomeInput,
} from "./contract";
import { projectSelectedShape } from "./shape";

const contextSchema = z
  .object({
    operation: operationSchema,
    callId: z.string().uuid().optional(),
    attempt: z.number().int().min(1).max(1000).optional(),
    correlation: correlationSchema.optional(),
    requestIncidentId: z.string().uuid().optional(),
  })
  .strict();
export type OutboundCallContext = z.infer<typeof contextSchema>;
export interface OutboundObserverOptions {
  collectorOrigin: string;
  ingestionToken: string;
  providerOrigin: string;
  integration: z.infer<typeof identitySchema>;
  sampleRate?: number;
  responsePointers?: string[];
  maxPending?: number;
  concurrency?: number;
  deliveryTimeoutMs?: number;
  bodyTimeoutMs?: number;
  providerVersionHeader?: "stripe-version" | "x-api-version" | "api-version";
}
function origin(input: string) {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error("Invalid observer origin");
  return url;
}
function limit(value: number | undefined, fallback: number, max: number) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > max)
    throw Error("Invalid observer limit");
  return result;
}
async function readProjection(
  response: Response,
  pointers: string[],
  timeoutMs: number,
): Promise<ObservationInput["capture"]> {
  const omitted = (
    omission: NonNullable<ObservationInput["capture"]["omission"]>,
  ): ObservationInput["capture"] => ({
    state: "OMITTED",
    pointers,
    projection: null,
    omission,
  });
  if (
    !/^(application\/json|application\/[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )
  )
    return omitted("NOT_JSON");
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return omitted("UNSUPPORTED_VALUE");
  }
  const reader = clone.body?.getReader();
  if (!reader) return omitted("INVALID_JSON");
  let timer: ReturnType<typeof setTimeout> | undefined,
    done = false;
  const task = (async () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 32768) {
          void reader.cancel().catch(() => {});
          return omitted("BODY_LIMIT");
        }
        chunks.push(chunk.value);
      }
      if (done) return omitted("BODY_TIMEOUT");
      const raw = Buffer.concat(chunks);
      try {
        const parsed: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            raw,
          ),
        );
        try {
          return {
            state: "CAPTURED" as const,
            pointers,
            projection: projectSelectedShape(parsed, pointers),
            omission: null,
          };
        } catch {
          return omitted("UNSUPPORTED_VALUE");
        }
      } catch {
        return omitted("INVALID_JSON");
      } finally {
        raw.fill(0);
        chunks.length = 0;
      }
    } catch {
      return omitted("INVALID_JSON");
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* A timed-out read may still own the lock. */
      }
    }
  })();
  try {
    return await Promise.race([
      task,
      new Promise<ObservationInput["capture"]>((resolve) => {
        timer = setTimeout(() => {
          done = true;
          void reader.cancel().catch(() => {});
          resolve(omitted("BODY_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function createOutboundObserver(options: OutboundObserverOptions) {
  const collector = origin(options.collectorOrigin),
    provider = origin(options.providerOrigin),
    integration = identitySchema.parse(options.integration);
  if (
    !/^st_ingest_v1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(
      options.ingestionToken,
    )
  )
    throw Error("Invalid ingestion credential");
  const rate = z
    .number()
    .finite()
    .min(0)
    .max(1)
    .parse(options.sampleRate ?? 1);
  const pointers = z
    .array(pointerSchema)
    .max(16)
    .parse(options.responsePointers ?? [])
    .sort();
  if (new Set(pointers).size !== pointers.length)
    throw Error("Duplicate selected fields");
  const maxPending = limit(options.maxPending, 32, 128),
    concurrency = limit(options.concurrency, 2, 8),
    deliveryTimeout = limit(options.deliveryTimeoutMs, 2000, 5000),
    bodyTimeout = limit(options.bodyTimeoutMs, 500, 2000);
  if (
    options.providerVersionHeader &&
    !["stripe-version", "x-api-version", "api-version"].includes(
      options.providerVersionHeader,
    )
  )
    throw Error("Unallowlisted version header");
  const token = options.ingestionToken,
    versionHeader = options.providerVersionHeader;
  const startedAt = new Date().toISOString(),
    instanceId = randomUUID();
  let sequence = 0,
    closed = false;
  const counters = {
    seen: 0,
    sampled: 0,
    unsampled: 0,
    dropped: 0,
    delivered: 0,
    deliveryUnconfirmed: 0,
    bodyOmitted: 0,
  };
  const observing = new Set<string>(),
    active = new Set<AbortController>(),
    queue: ObservationInput[] = [];
  const pending = () => observing.size + active.size + queue.length;
  async function post(path: string, body: unknown, signal: AbortSignal) {
    const response = await fetch(new URL(path, collector), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    void response.body?.cancel().catch(() => {});
    return response.status === 200 || response.status === 202;
  }
  function pump() {
    while (!closed && queue.length && active.size < concurrency) {
      const event = queue.shift();
      if (!event) break;
      const controller = new AbortController();
      active.add(controller);
      void (async () => {
        let delivered = false;
        try {
          delivered = await post(
            "/api/internal/integration-observations",
            event,
            AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(deliveryTimeout),
            ]),
          );
        } catch {
        } finally {
          active.delete(controller);
          if (delivered) counters.delivered++;
          else counters.deliveryUnconfirmed++;
          pump();
        }
      })();
    }
  }
  function enqueue(
    key: string,
    event: ReturnType<typeof observationSchema.safeParse>,
  ) {
    if (!observing.delete(key)) return;
    if (closed || !event.success) {
      counters.dropped++;
      return;
    }
    queue.push(event.data);
    pump();
  }
  return {
    async fetch(
      input: string | URL,
      init: RequestInit | undefined,
      rawContext: OutboundCallContext,
    ): Promise<Response> {
      const occurredAt = new Date().toISOString(),
        start = performance.now();
      counters.seen++;
      const selected =
        rate === 1 || (rate > 0 && randomInt(1_000_000) < rate * 1_000_000);
      let key: string | null = null;
      const context = contextSchema.safeParse(rawContext);
      if (!selected) counters.unsampled++;
      else {
        counters.sampled++;
        let matches = false;
        try {
          matches = new URL(input).origin === provider.origin;
        } catch {}
        if (
          closed ||
          !context.success ||
          !matches ||
          context.data.operation.method !==
            (init?.method ?? "GET").toUpperCase() ||
          pending() >= maxPending
        )
          counters.dropped++;
        else {
          key = randomUUID();
          observing.add(key);
        }
      }
      const base = () => {
        if (!context.success) throw Error("Invalid observer context");
        return {
          version: 1 as const,
          kind: "observation" as const,
          sourceEventId: key!,
          callId: context.data.callId ?? key!,
          attempt: context.data.attempt ?? 1,
          integration,
          operation: context.data.operation,
          occurredAt,
          durationMs: Math.min(
            86_400_000,
            Math.max(0, performance.now() - start),
          ),
          correlation: context.data.correlation ?? null,
          sampleRate: rate,
          ...(context.data.requestIncidentId
            ? { requestIncidentId: context.data.requestIncidentId }
            : {}),
        };
      };
      let response: Response;
      try {
        response = await fetch(input, init);
      } catch (error) {
        if (key && observing.has(key)) {
          const reason = init?.signal?.reason;
          const name = init?.signal?.aborted
            ? reason instanceof Error && reason.name === "TimeoutError"
              ? "TimeoutError"
              : "AbortError"
            : error instanceof Error
              ? error.name
              : "";
          const result = {
            kind:
              name === "TimeoutError"
                ? ("TIMEOUT" as const)
                : name === "AbortError"
                  ? ("ABORTED" as const)
                  : ("TRANSPORT" as const),
          };
          enqueue(
            key,
            observationSchema.safeParse({
              ...base(),
              result,
              capture: {
                state: "NO_RESPONSE",
                pointers,
                projection: null,
                omission: null,
              },
            }),
          );
        }
        throw error;
      }
      if (key && observing.has(key)) {
        const fixed = base();
        let originMatched = false;
        try {
          originMatched =
            !response.redirected &&
            new URL(response.url).origin === provider.origin;
        } catch {}
        const rawVersion =
          originMatched && versionHeader
            ? response.headers.get(versionHeader)
            : null;
        const providerVersion =
          rawVersion && /^[0-9][A-Za-z0-9._-]{0,31}$/.test(rawVersion)
            ? rawVersion
            : null;
        const result = {
          kind: "HTTP" as const,
          statusCode: response.status,
          originMatched,
          providerVersion,
        };
        const id = key;
        if (!pointers.length)
          enqueue(
            id,
            observationSchema.safeParse({
              ...fixed,
              result,
              capture: {
                state: "OFF",
                pointers: [],
                projection: null,
                omission: null,
              },
            }),
          );
        else if (!originMatched) {
          counters.bodyOmitted++;
          enqueue(
            id,
            observationSchema.safeParse({
              ...fixed,
              result,
              capture: {
                state: "OMITTED",
                pointers,
                projection: null,
                omission: "UNSUPPORTED_VALUE",
              },
            }),
          );
        } else
          void readProjection(response, pointers, bodyTimeout)
            .then((capture) => {
              if (capture.state === "OMITTED") counters.bodyOmitted++;
              enqueue(
                id,
                observationSchema.safeParse({
                  ...fixed,
                  result,
                  capture: captureSchema.parse(capture),
                }),
              );
            })
            .catch(() => {
              if (observing.delete(id)) counters.dropped++;
            });
      }
      return response;
    },
    stats() {
      return { ...counters, pending: pending(), closed };
    },
    async flush(timeoutMs = 3000) {
      const deadline = Date.now() + limit(timeoutMs, 3000, 10_000);
      while (pending() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const settled = pending() === 0;
      const snapshot: CoverageInput = coverageSchema.parse({
        version: 1,
        kind: "coverage",
        sourceEventId: randomUUID(),
        instanceId,
        sequence: ++sequence,
        integration,
        startedAt,
        reportedAt: new Date().toISOString(),
        sampleRate: rate,
        counters: { ...counters, pending: pending() },
      });
      let coverageDelivered = false;
      try {
        coverageDelivered = await post(
          "/api/internal/integration-observations",
          snapshot,
          AbortSignal.timeout(
            Math.max(1, Math.min(deliveryTimeout, deadline - Date.now())),
          ),
        );
      } catch {}
      return {
        settled,
        coverageDelivered,
        stats: { ...counters, pending: pending(), closed },
      };
    },
    async outcome(
      input: Omit<
        OutcomeInput,
        "version" | "integration" | "sourceEventId" | "occurredAt"
      > & { sourceEventId?: string; occurredAt?: string },
    ) {
      if (closed) return false;
      const event = outcomeSchema.parse({
        ...input,
        version: 1,
        integration,
        sourceEventId: input.sourceEventId ?? randomUUID(),
        occurredAt: input.occurredAt ?? new Date().toISOString(),
      });
      try {
        return await post(
          "/api/internal/workflow-outcomes",
          event,
          AbortSignal.timeout(deliveryTimeout),
        );
      } catch {
        return false;
      }
    },
    close() {
      closed = true;
      counters.dropped += observing.size + queue.length;
      observing.clear();
      queue.length = 0;
      for (const controller of active) controller.abort();
    },
  };
}
