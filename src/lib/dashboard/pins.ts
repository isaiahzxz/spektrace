import { parseScopeToken } from "@/lib/dashboard/scope";

export const PIN_VERSION = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)$/;
const PATH = /^\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{0,180}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$/;

export type Pin =
  | { kind: "incident"; id: string; shortId: string; method: string; path: string; service: string | null; environment: string | null }
  | { kind: "revision"; id: string; service: string; version: string; environment: string }
  | { kind: "comparison"; service: string; environment: string; leftId: string; rightId: string; leftVersion: string; rightVersion: string };

export function pinKey(pin: Pin): string {
  if (pin.kind === "incident") return `incident:${pin.id}`;
  if (pin.kind === "revision") return `revision:${pin.id}`;
  return `comparison:${pin.service}:${pin.environment}:${pin.leftId}:${pin.rightId}`;
}

export function pinHref(pin: Pin): string {
  if (pin.kind === "incident") {
    const params = new URLSearchParams({ incident: pin.id, inspect: "1" });
    if (pin.service) params.set("svc", pin.service);
    if (pin.environment) params.set("env", pin.environment);
    return `/dashboard/incidents?${params.toString()}`;
  }
  if (pin.kind === "revision") {
    return `/dashboard/specs/${encodeURIComponent(pin.service)}?environment=${encodeURIComponent(pin.environment)}`;
  }
  const params = new URLSearchParams({
    environment: pin.environment,
    left: pin.leftId,
    right: pin.rightId,
  });
  return `/dashboard/specs/${encodeURIComponent(pin.service)}?${params.toString()}`;
}

function parsePin(value: unknown): Pin | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "incident") {
    if (typeof raw.id !== "string" || !UUID.test(raw.id)) return null;
    if (typeof raw.method !== "string" || !METHOD.test(raw.method)) return null;
    if (typeof raw.path !== "string" || !PATH.test(raw.path)) return null;
    return {
      kind: "incident",
      id: raw.id.toLowerCase(),
      shortId: raw.id.slice(0, 8).toLowerCase(),
      method: raw.method,
      path: raw.path,
      service: typeof raw.service === "string" ? parseScopeToken(raw.service) : null,
      environment: typeof raw.environment === "string" ? parseScopeToken(raw.environment) : null,
    };
  }
  if (raw.kind === "revision") {
    if (typeof raw.id !== "string" || !UUID.test(raw.id)) return null;
    const service = typeof raw.service === "string" ? parseScopeToken(raw.service) : null;
    const environment = typeof raw.environment === "string" ? parseScopeToken(raw.environment) : null;
    if (!service || !environment || typeof raw.version !== "string" || !VERSION.test(raw.version)) return null;
    return { kind: "revision", id: raw.id.toLowerCase(), service, version: raw.version, environment };
  }
  if (raw.kind === "comparison") {
    const service = typeof raw.service === "string" ? parseScopeToken(raw.service) : null;
    const environment = typeof raw.environment === "string" ? parseScopeToken(raw.environment) : null;
    if (!service || !environment) return null;
    if (typeof raw.leftId !== "string" || !UUID.test(raw.leftId) || typeof raw.rightId !== "string" || !UUID.test(raw.rightId)) return null;
    if (raw.leftId === raw.rightId) return null;
    if (typeof raw.leftVersion !== "string" || !VERSION.test(raw.leftVersion)) return null;
    if (typeof raw.rightVersion !== "string" || !VERSION.test(raw.rightVersion)) return null;
    return {
      kind: "comparison",
      service,
      environment,
      leftId: raw.leftId.toLowerCase(),
      rightId: raw.rightId.toLowerCase(),
      leftVersion: raw.leftVersion,
      rightVersion: raw.rightVersion,
    };
  }
  return null;
}

export function parsePinStore(raw: unknown): { pins: Pin[]; dropped: number } {
  if (!raw || typeof raw !== "object") return { pins: [], dropped: 0 };
  const record = raw as { version?: unknown; pins?: unknown };
  if (record.version !== PIN_VERSION || !Array.isArray(record.pins)) return { pins: [], dropped: 0 };
  const pins: Pin[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of record.pins) {
    const pin = parsePin(item);
    if (!pin) {
      dropped += 1;
      continue;
    }
    const key = pinKey(pin);
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    pins.push(pin);
  }
  return { pins, dropped };
}

export function serializePins(pins: Pin[]): string {
  return JSON.stringify({ version: PIN_VERSION, pins });
}

export function addPin(pins: Pin[], pin: Pin): Pin[] {
  const key = pinKey(pin);
  return [pin, ...pins.filter((item) => pinKey(item) !== key)];
}

export function removePin(pins: Pin[], key: string): Pin[] {
  return pins.filter((pin) => pinKey(pin) !== key);
}
