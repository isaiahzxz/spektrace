import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

const internalSchema = z.object({
  SPEKTRACE_INTERNAL_API_TOKEN: z.string().min(32).optional(),
  SPEKTRACE_INTERNAL_WORKSPACE_ID: z.string().uuid().optional(),
  SPEKTRACE_REDIS_PREFIX: z.string().min(1).optional(),
});

export type InternalPilotConfig = {
  apiToken: string;
  workspaceId: string;
  redisPrefix: string;
};

export function getRedisKeyPrefix(): string {
  const parsed = internalSchema.safeParse(process.env);
  return parsed.success && parsed.data.SPEKTRACE_REDIS_PREFIX
    ? parsed.data.SPEKTRACE_REDIS_PREFIX
    : "spektrace";
}

export function requireInternalPilotConfig(): InternalPilotConfig {
  const parsed = internalSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new InternalConfigError("Internal pilot configuration is invalid");
  }
  const token = parsed.data.SPEKTRACE_INTERNAL_API_TOKEN;
  const workspaceId = parsed.data.SPEKTRACE_INTERNAL_WORKSPACE_ID;
  if (!token || !workspaceId) {
    throw new InternalConfigError(
      "SPEKTRACE_INTERNAL_API_TOKEN and SPEKTRACE_INTERNAL_WORKSPACE_ID are required",
    );
  }
  return {
    apiToken: token,
    workspaceId,
    redisPrefix: parsed.data.SPEKTRACE_REDIS_PREFIX ?? "spektrace",
  };
}

/** Workspace for the local pilot dashboard. This is tenant context, not authentication. */
export function requirePilotWorkspaceId(): string {
  const parsed = internalSchema
    .pick({ SPEKTRACE_INTERNAL_WORKSPACE_ID: true })
    .safeParse(process.env);
  const workspaceId = parsed.success
    ? parsed.data.SPEKTRACE_INTERNAL_WORKSPACE_ID
    : undefined;
  if (!workspaceId) {
    throw new InternalConfigError(
      "SPEKTRACE_INTERNAL_WORKSPACE_ID must be set to a workspace UUID",
    );
  }
  return workspaceId;
}

export class InternalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalConfigError";
  }
}

export function verifyInternalApiToken(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (!provided) {
    return false;
  }
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}
