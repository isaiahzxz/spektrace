import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildPayloadDiff } from "@/lib/payload-proposal/payload-diff";
import { PayloadDiff } from "@/components/dashboard/payload-diff";

const original = '{\n  "amount": "100"\n}';
const candidate = '{\n  "amount": 100\n}';
describe("stored request and candidate comparison", () => {
  it("makes the string-to-number change explicit without discarding quotation marks", () => {
    expect(buildPayloadDiff(original, candidate)).toEqual({ status: "changed", rows: [
      { kind: "context", text: "{" }, { kind: "removed", text: '  "amount": "100"' },
      { kind: "added", text: '  "amount": 100' }, { kind: "context", text: "}" },
    ] });
  });
  it("updates the comparison for manual changes instead of retaining an earlier proposal", () => {
    const result = buildPayloadDiff(original, '{\n  "amount": 200\n}');
    expect(result).toMatchObject({ status: "changed", rows: expect.arrayContaining([{ kind: "added", text: '  "amount": 200' }]) });
  });
  it("reports an unchanged candidate without suggesting a correction", () => {
    expect(buildPayloadDiff(original, original)).toEqual({ status: "unchanged" });
    expect(buildPayloadDiff(original.replace(/\n/g, "\r\n"), original)).toEqual({ status: "unchanged" });
  });
  it.each([
    ["a\na\nb", "a\nb\nb"],
    ["a\nb", "b\na"],
    ['{"items":[1,2]}', '{"items":[1,3,4]}'],
    ["a\n\nb", "a\nb\n"],
    ["", "hello"],
    ["hello", ""],
    ['{"optional":null}', '{}'],
  ])("preserves both complete texts across insertions, deletions, and repeated lines", (before, after) => {
    const diff = buildPayloadDiff(before, after);
    expect(diff.status).toBe("changed");
    if (diff.status !== "changed") throw new Error("Expected comparison rows");
    expect(diff.rows.filter(row => row.kind !== "added").map(row => row.text).join("\n")).toBe(before);
    expect(diff.rows.filter(row => row.kind !== "removed").map(row => row.text).join("\n")).toBe(after);
  });
  it("shows invalid edits and duplicate keys verbatim rather than hiding them through JSON parsing", () => {
    const after = '{\n  "amount": "unexpected",\n  "amount": 100,\n}';
    const diff = buildPayloadDiff(original, after);
    expect(diff).toMatchObject({ status: "changed", rows: expect.arrayContaining([{ kind: "added", text: '  "amount": "unexpected",' }, { kind: "added", text: '  "amount": 100,' }]) });
  });
  it.each(["a".repeat(65_537), Array.from({ length: 301 }, () => "a").join("\n")])("bounds expensive comparisons explicitly instead of silently truncating changes", large => {
    expect(buildPayloadDiff(original, large)).toEqual({ status: "limited" });
  });
  it("renders stored/candidate labels and safely escapes payload content", () => {
    const html = renderToStaticMarkup(createElement(PayloadDiff, { originalText: original, candidateText: '<script>alert("unsafe")</script>' }));
    expect(html).toContain("− Original (stored)"); expect(html).toContain("+ Candidate");
    expect(html).toContain("Original: "); expect(html).toContain("Candidate: ");
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
    expect(html).toContain('tabindex="0"');
  });
  it("shows the complete stored original in the large-payload fallback", () => {
    const html = renderToStaticMarkup(createElement(PayloadDiff, { originalText: original, candidateText: "a".repeat(65_537) }));
    expect(html).toContain("Inline diff is unavailable"); expect(html).toContain("Original payload, stored");
    expect(html).toContain('&quot;amount&quot;: &quot;100&quot;');
  });
});
