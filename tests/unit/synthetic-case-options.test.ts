import { describe, expect, it } from "vitest";
import { parseSyntheticCaseOptions } from "../../scripts/lib/synthetic-case-options";
describe("bounded synthetic case selection", () => {
  it("preserves the existing C default", () => {
    expect(parseSyntheticCaseOptions([])).toEqual({ caseId: "C", configOnly: false, reviewRejection: false });
  });
  it.each(["A", "B", "C"])("selects only synthetic case %s", (caseId) => {
    expect(parseSyntheticCaseOptions([`--case=${caseId}`, "--config-only", "--review-rejection"])).toEqual({ caseId, configOnly: true, reviewRejection: true });
  });
  it.each([["--case=D"], ["--workspace=real"], ["--ack-reset"], ["--case=A", "--case=B"], ["--case=A", "--case=A"]])("refuses unsupported scope and multiple cases: %j", (...args) => {
    expect(() => parseSyntheticCaseOptions(args)).toThrow();
  });
});
