export function parseSyntheticCaseOptions(args: string[]) {
  if (args.some((arg) => !["--config-only", "--review-rejection", "--case=A", "--case=B", "--case=C"].includes(arg))) throw new Error("Unsupported synthetic check argument");
  const cases = args.filter((arg) => arg.startsWith("--case="));
  if (cases.length > 1) throw new Error("Select only one synthetic case per request");
  return { caseId: (cases[0]?.slice(7) ?? "C") as "A" | "B" | "C", configOnly: args.includes("--config-only"), reviewRejection: args.includes("--review-rejection") };
}
