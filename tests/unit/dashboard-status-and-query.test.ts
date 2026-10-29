import { describe, expect, it } from "vitest";
import type { IncidentStatus, ValidationStatus } from "@/generated/prisma/enums";
import type { FindingView } from "@/lib/dashboard/evidence-adapter";
import { driftLabel, filterIncludesCategory, statusCategory } from "@/lib/dashboard/incident-status";
import { frequencyBand } from "@/lib/dashboard/frequency-band";
import { parseHistoryRange } from "@/lib/dashboard/history-range";
import { buildQueueHref, formatUtc, parseQueueQuery } from "@/lib/dashboard/queue-query";

const finding = (keyword: string): FindingView => ({
  keyword,
  path: "/x",
  pathNote: null,
  rule: keyword,
  expected: "",
  received: "",
  message: "",
  schemaPath: "",
});

describe("statusCategory", () => {
  const cases: Array<[IncidentStatus, ValidationStatus, string]> = [
    ["RECEIVED", "NOT_RUN", "pending"],
    ["VALIDATING", "NOT_RUN", "pending"],
    ["NEEDS_REVIEW", "MISMATCH", "triaged"],
    ["NEEDS_REVIEW", "PASSED", "triaged"],
    ["NEEDS_REVIEW", "UNSUPPORTED", "unsupported"],
    ["NEEDS_REVIEW", "ERROR", "failed"],
    ["FAILED", "NOT_RUN", "failed"],
    ["FAILED", "MISMATCH", "failed"],
    ["VALIDATING", "ERROR", "failed"],
  ];
  it.each(cases)("%s + %s is %s", (status, validation, expected) => {
    expect(statusCategory(status, validation)).toBe(expected);
  });

  it("keeps failed checks out of Pending and Triaged but in All", () => {
    expect(filterIncludesCategory("all", "failed")).toBe(true);
    expect(filterIncludesCategory("pending", "failed")).toBe(false);
    expect(filterIncludesCategory("triaged", "failed")).toBe(false);
    expect(filterIncludesCategory("triaged", "unsupported")).toBe(true);
  });
});

describe("driftLabel", () => {
  it("maps single findings by rule", () => {
    expect(driftLabel("triaged", "MISMATCH", [finding("type")]).label).toBe("Type mismatch");
    expect(driftLabel("triaged", "MISMATCH", [finding("required")]).label).toBe("Missing required field");
    expect(driftLabel("triaged", "MISMATCH", [finding("additionalProperties")]).label).toBe("Unexpected field");
    expect(driftLabel("triaged", "MISMATCH", [finding("enum")]).label).toBe("Enum mismatch");
    expect(driftLabel("triaged", "MISMATCH", [finding("minimum")]).label).toBe("Other schema rule");
  });

  it("labels multiple findings and non-mismatch states honestly", () => {
    expect(driftLabel("triaged", "MISMATCH", [finding("type"), finding("required")]).label).toBe("Multiple mismatches (2)");
    expect(driftLabel("triaged", "PASSED", []).label).toBe("No body mismatch");
    expect(driftLabel("pending", "NOT_RUN", []).label).toBe("Awaiting check");
    expect(driftLabel("unsupported", "UNSUPPORTED", []).label).toBe("Unsupported check");
    expect(driftLabel("failed", "ERROR", [finding("type")]).label).toBe("Check failed");
  });
});

describe("queue URL helpers", () => {
  const id = "8bc54506-889c-4fac-94bc-97314ef28ff1";

  it("parses filter, page and selection with safe fallbacks", () => {
    expect(parseQueueQuery({ filter: "pending", page: "3", incident: id })).toEqual({
      filter: "pending",
      page: 3,
      selected: { kind: "id", id },
      inspect: false,
      range: "month",
      service: null,
      environment: null,
      view: "queue",
    });
    expect(parseQueueQuery({ filter: "bogus", page: "-4", incident: "not-a-uuid", inspect: "1", range: "week", svc: "payments-api", env: "default" })).toEqual({
      filter: "all",
      page: 1,
      selected: { kind: "invalid" },
      inspect: true,
      range: "week",
      service: "payments-api",
      environment: "default",
      view: "queue",
    });
    expect(parseQueueQuery({}).selected).toEqual({ kind: "none" });
  });

  it("preserves the filter and page when selecting an incident", () => {
    const query = parseQueueQuery({ filter: "triaged", page: "2" });
    expect(buildQueueHref(query, { incidentId: id })).toBe(
      `/dashboard/incidents?filter=triaged&page=2&incident=${id}`,
    );
  });

  it("keeps the selection when changing filter", () => {
    const query = parseQueueQuery({ incident: id });
    expect(buildQueueHref(query, { filter: "pending", page: 1 })).toBe(
      `/dashboard/incidents?filter=pending&incident=${id}`,
    );
    expect(buildQueueHref(query, { incidentId: null })).toBe("/dashboard/incidents");
  });

  it("keeps an inclusive UTC end date and rejects a reversed range", () => {
    const now = new Date("2026-10-19T15:00:00.000Z");
    const fallback = parseHistoryRange({}, now);
    expect(fallback.from).toBe("2026-10-13");
    expect(fallback.to).toBe("2026-10-19");
    expect(fallback.endExclusive?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(parseHistoryRange({ from: "2026-10-19", to: "2026-10-01" }, now).error).toMatch(/after/);
    expect(parseHistoryRange({ from: "2026-02-31", to: "2026-03-01" }, now).error).toMatch(/YYYY-MM-DD/);
    expect(frequencyBand(4)).toBe("low");
    expect(frequencyBand(5)).toBe("medium");
    expect(frequencyBand(20)).toBe("high");
  });

  it("formats timestamps deterministically in UTC", () => {
    expect(formatUtc(new Date("2026-10-18T09:05:03.123Z"))).toBe("2026-10-18 09:05:03 UTC");
    expect(formatUtc(null)).toBeNull();
    expect(formatUtc("garbage")).toBeNull();
  });
});
