import { z } from "zod";

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9 ._+\-]{0,63}$/;

/**
 * Example headers a logging integration may read from the application request.
 * SpekTrace does not see those headers. The integration copies the chosen values
 * into the ingestion `client` object. A platform is not an SDK name.
 */
export const CLIENT_HEADER_MAP = [
  { header: "X-Spektrace-Application", field: "applicationName" },
  { header: "X-Spektrace-Application-Version", field: "applicationVersion" },
  { header: "X-Spektrace-Platform", field: "platform" },
  { header: "X-Spektrace-Sdk", field: "sdkName" },
  { header: "X-Spektrace-Sdk-Version", field: "sdkVersion" },
] as const;

const label = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(TOKEN, "Use letters, numbers, spaces, and . _ + -")
  .refine((value) => !/[@/\\]/.test(value) && !/bearer|cookie|authorization/i.test(value), "This value is not accepted as client attribution.");

export const clientAttributionSchema = z
  .object({
    applicationName: label.optional(),
    applicationVersion: label.optional(),
    platform: label.optional(),
    sdkName: label.optional(),
    sdkVersion: label.optional(),
  })
  .strict();

export type ClientAttribution = z.infer<typeof clientAttributionSchema>;

export function clientGroupKey(client: {
  applicationName: string | null;
  applicationVersion: string | null;
}) {
  if (!client.applicationName && !client.applicationVersion) return "Unknown";
  return `${client.applicationName ?? "Unknown"} ${client.applicationVersion ?? "Unknown"}`.trim();
}
