import { describe, expect, it } from "vitest";
import { historyHref, historyQueryScope, parseHistoryRange, receivedDuringInterval } from "@/lib/dashboard/history-range";

const now = new Date("2026-10-19T15:00:00.000Z");

describe("historical received-at interval", () => {
  it("treats a date-only end as inclusive through the next UTC day", () => {
    const range = parseHistoryRange({ from: "2026-10-19", to: "2026-10-19" }, now);
    expect(range.error).toBeNull();
    expect(range.start?.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(range.endExclusive?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    const start = range.start!;
    const end = range.endExclusive!;
    expect(receivedDuringInterval(new Date("2026-10-19T00:00:00.000Z"), start, end)).toBe(true);
    expect(receivedDuringInterval(new Date("2026-10-19T23:59:59.999Z"), start, end)).toBe(true);
    expect(receivedDuringInterval(new Date("2026-10-20T00:00:00.000Z"), start, end)).toBe(false);
    expect(receivedDuringInterval(new Date("2026-10-18T23:59:59.999Z"), start, end)).toBe(false);
  });

  it("rejects a missing side, a malformed date, and a reversed range", () => {
    expect(parseHistoryRange({ from: "2026-10-01" }, now).error).toMatch(/both/);
    expect(parseHistoryRange({ from: "2026-02-31", to: "2026-03-01" }, now).error).toMatch(/YYYY-MM-DD/);
    expect(parseHistoryRange({ from: "2026-10-19", to: "2026-10-01" }, now).error).toMatch(/after/);
  });

  it("scopes every module to one workspace and the same received-at bounds", () => {
    const range = parseHistoryRange({ from: "2026-10-01", to: "2026-10-07", page: "2" }, now);
    const scope = historyQueryScope("workspace-a", range);
    const again = historyQueryScope("workspace-a", range);
    expect(scope).toEqual(again);
    expect(scope?.workspaceId).toBe("workspace-a");
    expect(historyQueryScope("workspace-b", range)?.workspaceId).toBe("workspace-b");
    expect(scope?.receivedAt).toEqual({
      gte: new Date("2026-10-01T00:00:00.000Z"),
      lt: new Date("2026-10-08T00:00:00.000Z"),
    });
    expect(historyHref(range, { page: 2 })).toBe("/dashboard/history?from=2026-10-01&to=2026-10-07&page=2");
    expect(historyHref(range, { page: 3 }).includes("from=2026-10-01")).toBe(true);
  });
});
