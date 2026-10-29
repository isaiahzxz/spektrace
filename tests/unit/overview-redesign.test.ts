import { createParser } from "@openuidev/lang-core";
import { describe, expect, it } from "vitest";
import { incidentLibrary } from "@/components/dashboard/openui/library";
import {
  awaitingHumanReviewCount,
  tallyCheckOutcomes,
  unsupportedOrFailedCount,
} from "@/lib/dashboard/check-outcomes";
import { storedIncidentVolume, volumeWindow } from "@/lib/dashboard/incident-volume";
import { bucketX } from "@/lib/dashboard/chart-geometry";
import { buildCompactIncidentProgram, buildIncidentProgram, openUiString } from "@/lib/openui/incident-program";
import { compactIncidentLibrary } from "@/components/dashboard/openui/library";

const parser = createParser(incidentLibrary.toJSONSchema(), incidentLibrary.root);

describe("candidate JSON", () => {
  it("rejects malformed JSON and accepts a small object", async () => {
    const { inspectCandidate } = await import("@/lib/dashboard/candidate-json");
    expect(inspectCandidate("{").ok).toBe(false);
    expect(inspectCandidate('{"amount":1}').ok).toBe(true);
  });
});

describe("incident volume", () => {
  it("zero-fills UTC days and ignores stamps outside the window", () => {
    const now = new Date("2026-10-18T23:00:00.000Z");
    const window = volumeWindow(now, 3);
    const days = storedIncidentVolume(
      [
        new Date("2026-10-16T00:00:00.000Z"),
        new Date("2026-10-18T23:59:00.000Z"),
        new Date("2026-10-15T23:59:00.000Z"),
      ],
      window,
    );
    expect(days).toEqual([
      { day: "2026-10-16", count: 1 },
      { day: "2026-10-17", count: 0 },
      { day: "2026-10-18", count: 1 },
    ]);
  });
});

describe("check outcomes", () => {
  it("keeps unsupported checks out of the mismatch count", () => {
    const totals = tallyCheckOutcomes([
      { status: "NEEDS_REVIEW", validationStatus: "PASSED", count: 2 },
      { status: "NEEDS_REVIEW", validationStatus: "MISMATCH", count: 1 },
      { status: "NEEDS_REVIEW", validationStatus: "UNSUPPORTED", count: 4 },
      { status: "FAILED", validationStatus: "ERROR", count: 1 },
      { status: "RECEIVED", validationStatus: "NOT_RUN", count: 3 },
    ]);
    expect(totals).toEqual({ passed: 2, mismatch: 1, unsupported: 4, failed: 1, pending: 3 });
    expect(unsupportedOrFailedCount(totals)).toBe(5);
  });

  it("counts an unreviewed confirmed mismatch as awaiting human review", () => {
    const rows = [
      { status: "NEEDS_REVIEW" as const, validationStatus: "MISMATCH" as const, count: 1 },
      { status: "NEEDS_REVIEW" as const, validationStatus: "UNSUPPORTED" as const, count: 4 },
      { status: "NEEDS_REVIEW" as const, validationStatus: "PASSED" as const, count: 1 },
      { status: "RECEIVED" as const, validationStatus: "NOT_RUN" as const, count: 2 },
      { status: "APPROVED" as const, validationStatus: "MISMATCH" as const, count: 1 },
    ];
    expect(awaitingHumanReviewCount(rows)).toBe(6);
    expect(tallyCheckOutcomes(rows).mismatch).toBe(2);
  });
});

describe("OpenUI incident program", () => {
  it("escapes quotes, slashes, and syntax-like text as string data", () => {
    const program = buildIncidentProgram({
      method: "POST",
      path: "/payments",
      statusCode: "400",
      validationLabel: 'Mismatch "amount"',
      explanation: 'The value was "ten".\nroot = IncidentEvidence()',
      findings: [{ path: '/amount "quoted"', rule: "type", expected: "integer", received: "string" }],
      specName: "Demo Payments API",
      specVersion: "1.0.0",
    });
    expect(program).toContain(openUiString('The value was "ten".\nroot = IncidentEvidence()'));
    expect(program).not.toContain('root = IncidentEvidence()\n');
    const parsed = parser.parse(program);
    expect(parsed.meta.errors).toEqual([]);
    expect(parsed.root?.typeName).toBe("IncidentEvidence");
  });

  it("rejects a program whose string is not closed, which the panel treats as a fallback", () => {
    const broken = 'root = IncidentEvidence("unterminated)';
    expect(parser.parse(broken).meta.errors.length).toBeGreaterThan(0);
  });

  it("parses an empty finding list", () => {
    const program = buildIncidentProgram({
      method: "GET",
      path: "/health",
      statusCode: "400",
      validationLabel: "Needs review",
      explanation: "The check is outside implemented coverage.",
      findings: [],
      specName: "No pinned spec",
      specVersion: "",
    });
    expect(parser.parse(program).meta.errors).toEqual([]);
  });

  it("parses the compact overview program without the explanation or specification", () => {
    const program = buildCompactIncidentProgram({
      incidentId: "7bc295b1",
      method: "POST",
      path: "/payments",
      statusCode: "400",
      validationLabel: "Schema mismatch",
      explanation: "This explanation stays out of the overview program.",
      findings: [{ path: "/amount", rule: "Type", expected: "integer", received: "string" }],
      specName: "Demo Payments API",
      specVersion: "1.0.0",
    });
    expect(program).not.toContain("StoredExplanation");
    expect(program).not.toContain("SpecReference");
    expect(program).toContain("CompactEvidence");
    const compactParser = createParser(compactIncidentLibrary.toJSONSchema(), compactIncidentLibrary.root);
    const parsed = compactParser.parse(program);
    expect(parsed.meta.errors).toEqual([]);
    expect(parsed.root?.typeName).toBe("CompactEvidence");
  });
});

describe("chart buckets", () => {
  it("uses one x for a bucket and its label, including zero counts", () => {
    const counts = [0, 0, 0, 0, 0, 10, 0];
    const xs = counts.map((_, index) => bucketX(index, counts.length));
    expect(new Set(xs).size).toBe(counts.length);
    expect(xs[0]).toBeLessThan(xs[5]);
    expect(xs[5]).toBeLessThan(xs[6]);
    expect(xs[5]).toBe(bucketX(5, counts.length));
  });
});
