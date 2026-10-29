const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|credential)/i;

export const MAX_DEPTH = 8;
export const MAX_KEYS = 200;

export const OMITTED_DEPTH_LIMIT = "[OMITTED:DEPTH_LIMIT]";
export const OMITTED_KEY_LIMIT = "[OMITTED:KEY_LIMIT]";

export type RedactionResult = {
  value: unknown;
  redactedPaths: string[];
  /** When true, validation must not treat the redacted body as faithful to the original. */
  validationBlocked: boolean;
  /** When true, traversal stopped early (depth or key budget); content is incomplete. */
  incomplete: boolean;
};

function depthLimitResult(path: string): RedactionResult {
  return {
    value: OMITTED_DEPTH_LIMIT,
    redactedPaths: path ? [path] : [],
    validationBlocked: true,
    incomplete: true,
  };
}

export function redactSanitizedRequestBody(
  input: unknown,
  path = "",
  depth = 0,
  keyCount = { n: 0 },
): RedactionResult {
  if (depth > MAX_DEPTH) {
    return depthLimitResult(path);
  }

  if (input === null || typeof input !== "object") {
    return { value: input, redactedPaths: [], validationBlocked: false, incomplete: false };
  }

  if (Array.isArray(input)) {
    const redactedPaths: string[] = [];
    let validationBlocked = false;
    let incomplete = false;
    const value = input.map((item, index) => {
      const child = redactSanitizedRequestBody(
        item,
        `${path}/${index}`,
        depth + 1,
        keyCount,
      );
      redactedPaths.push(...child.redactedPaths);
      validationBlocked ||= child.validationBlocked;
      incomplete ||= child.incomplete;
      return child.value;
    });
    return { value, redactedPaths, validationBlocked, incomplete };
  }

  const redactedPaths: string[] = [];
  let validationBlocked = false;
  let incomplete = false;
  const output: Record<string, unknown> = {};
  let keyLimitReached = false;

  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    keyCount.n += 1;
    if (keyCount.n > MAX_KEYS) {
      validationBlocked = true;
      incomplete = true;
      keyLimitReached = true;
      const limitPath = path ? `${path}/${OMITTED_KEY_LIMIT}` : `/${OMITTED_KEY_LIMIT}`;
      redactedPaths.push(limitPath);
      break;
    }

    const childPath = path ? `${path}/${key}` : `/${key}`;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      redactedPaths.push(childPath);
      output[key] = "[REDACTED]";
      validationBlocked = true;
      continue;
    }

    const child = redactSanitizedRequestBody(raw, childPath, depth + 1, keyCount);
    redactedPaths.push(...child.redactedPaths);
    validationBlocked ||= child.validationBlocked;
    incomplete ||= child.incomplete;
    output[key] = child.value;
  }

  if (keyLimitReached) {
    output[OMITTED_KEY_LIMIT] = OMITTED_KEY_LIMIT;
  }

  return { value: output, redactedPaths, validationBlocked, incomplete };
}
