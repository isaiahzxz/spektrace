/** Synthetic application monitoring adapter (local pilot). */
export const APPLICATION_MONITORING_ADAPTER = {
  sdkName: "spektrace-appmon-adapter",
  sdkVersion: "1.0.0",
  defaultSource: "WEBHOOK" as const,
  maxClientReferenceLength: 512,
} as const;
