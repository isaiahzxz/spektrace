import { pointerSchema, projectionSchema, type Projection } from "./contract";

export function jsonType(value: unknown): Projection["rootType"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Unsupported numeric value");
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (["string", "boolean", "object"].includes(typeof value))
    return typeof value as "string" | "boolean" | "object";
  throw new Error("Unsupported JSON value");
}
export function projectSelectedShape(
  value: unknown,
  selected: readonly string[],
): Projection {
  if (selected.length > 16 || new Set(selected).size !== selected.length)
    throw new Error("Invalid selected fields");
  const fields = [...selected].sort().map((raw) => {
    const pointer = pointerSchema.parse(raw);
    let current = value,
      found = true;
    for (const key of pointer.slice(1).split("/")) {
      if (
        !current ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        !Object.hasOwn(current, key)
      ) {
        found = false;
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor))
        throw new Error("Unsupported accessor");
      current = descriptor.value;
    }
    if (!found) return { pointer, presence: "missing" as const, type: null };
    const type = jsonType(current);
    if (Array.isArray(current) && current.length > 100)
      throw new Error("Array observation limit");
    return {
      pointer,
      presence: "present" as const,
      type,
      ...(Array.isArray(current)
        ? { elementTypes: [...new Set(current.map(jsonType))].sort() }
        : {}),
    };
  });
  return projectionSchema.parse({
    policy: "selected-fields@1",
    rootType: jsonType(value),
    fields,
  });
}
