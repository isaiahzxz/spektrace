const sensitiveKey = /password|passwd|secret|token|authorization|cookie|api[_-]?key|credential|card|cvv|cvc|email|phone|address|ssn/i;
const sensitiveValue = /bearer\s|-----BEGIN|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|\[(?:REDACTED|OMITTED(?::[^\]]*)?)\]|[^\s@]+@[^\s@]+\.[^\s@]+|\d[\d -]{11,30}\d/i;

export interface SenderReference { principalRef: string; principalKind: "client_id" | "api_key_id" }
export function senderAlias(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
    ? value.toLowerCase() : undefined;
}
export function protectedSenderReference(input: unknown): SenderReference | undefined {
  if (input === undefined) return undefined;
  if (input instanceof Promise) { void input.catch(() => {}); throw new Error("Sender omitted"); }
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length)
    throw new Error("Sender omitted");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(fields).length !== 2 || !fields.principalRef || !fields.principalKind ||
    !("value" in fields.principalRef) || !("value" in fields.principalKind)) throw new Error("Sender omitted");
  const principalRef = senderAlias(fields.principalRef.value);
  const principalKind: unknown = fields.principalKind.value;
  if (!principalRef || (principalKind !== "client_id" && principalKind !== "api_key_id")) throw new Error("Sender omitted");
  return { principalRef, principalKind };
}

export function protectedBody(input: unknown): unknown {
  let keys = 0;
  const seen = new WeakSet<object>();
  function copy(value: unknown, depth: number): unknown {
    if (depth > 8) throw new Error("Body omitted");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length <= 512 && !sensitiveValue.test(value)) return value;
    if (!value || typeof value !== "object" || seen.has(value)) throw new Error("Body omitted");
    if (value instanceof Promise) { void value.catch(() => {}); throw new Error("Body omitted"); }
    seen.add(value);
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Body omitted");
    if (Object.getOwnPropertySymbols(value).length) throw new Error("Body omitted");
    const output: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    if (array && value.length > 200) throw new Error("Body omitted");
    if (Object.getOwnPropertyDescriptor(value, "toJSON")) throw new Error("Body omitted");
    if (array) {
      for (let i = 0; i < value.length; i++) {
        if (++keys > 200) throw new Error("Body omitted");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !("value" in descriptor)) throw new Error("Body omitted");
        Object.defineProperty(output, String(i), { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
      }
      for (const key in value) if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) throw new Error("Body omitted");
      return output;
    }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++keys > 200 || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(key) || sensitiveKey.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Body omitted");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("Body omitted");
      Object.defineProperty(output, key, { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return output;
  }
  const result = copy(input, 0);
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") > 32_768 || sensitiveValue.test(serialized)) throw new Error("Body omitted");
  return result;
}

export function operationTemplate(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || /[?#\s\\%]/.test(value)) return null;
  if (value === "/") return value;
  const segments = value.slice(1).split("/");
  return segments.every((part) => /^(?:[A-Za-z][A-Za-z0-9._-]{0,63}|\{[A-Za-z_][A-Za-z0-9_]{0,63}\})$/.test(part)
    && !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(part)) ? value : null;
}

export function clientLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const label = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._+\-]{0,63}$/.test(label) && !/bearer|cookie|authorization/i.test(label) && !sensitiveValue.test(label) ? label : undefined;
}
