import { describe, expect, it } from "vitest";
import { writeStoredText } from "@/lib/dashboard/browser-store";
import { environmentHref, incidentScopeWhere } from "@/lib/dashboard/scope";
import { addPin, parsePinStore, pinKey, serializePins } from "@/lib/dashboard/pins";
import { filtersFromSearch, parseSavedViewStore, serializeSavedViews, summarizeFilters, viewHref, type SavedView } from "@/lib/dashboard/saved-views";

describe("browser storage writes", () => {
  it("leaves the previous entry in place when the browser refuses the write", () => {
    const data = new Map<string, string>([["spektrace-views:workspace", "{\"version\":1,\"views\":[]}"]]);
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value.includes("new")) throw new Error("quota");
        data.set(key, value);
      },
    };
    expect(writeStoredText(storage, "spektrace-views:workspace", "{\"version\":1,\"views\":[{\"name\":\"new\"}]}")).toBe(false);
    expect(storage.getItem("spektrace-views:workspace")).toBe("{\"version\":1,\"views\":[]}");
    expect(writeStoredText(storage, "spektrace-views:workspace", "{\"version\":1,\"views\":[]}")).toBe(true);
  });
});

describe("environment scope", () => {
  it("keeps a date range and drops the open incident when the environment changes", () => {
    const current = new URLSearchParams("from=2026-10-01&to=2026-10-19&incident=8bc54506-889c-4fac-94bc-97314ef28ff1&inspect=1");
    expect(environmentHref("/dashboard/history", current, "default")).toBe("/dashboard/history?from=2026-10-01&to=2026-10-19&env=default&environment=default");
    expect(environmentHref("/dashboard", current, null)).toBe("/dashboard?from=2026-10-01&to=2026-10-19");
  });

  it("does not invent an environment filter", () => {
    expect(incidentScopeWhere({ service: "payments-api", environment: null })).toEqual({ apiKey: "payments-api" });
    expect(incidentScopeWhere({ service: null, environment: "default" })).toEqual({ environment: "default" });
  });
});

describe("saved views", () => {
  it("keeps rolling presets and fixed dates apart, and ignores the selected incident", () => {
    const rolling = filtersFromSearch(new URLSearchParams("range=week&incident=8bc54506-889c-4fac-94bc-97314ef28ff1&inspect=1&page=3"), "overview");
    expect(rolling.range).toBe("week");
    expect(rolling.from).toBeNull();
    expect(summarizeFilters(rolling)).toContain("Rolling week");

    const fixed = filtersFromSearch(new URLSearchParams("from=2026-10-01&to=2026-10-19&range=week&env=default"), "history");
    expect(fixed.range).toBeNull();
    expect(fixed.from).toBe("2026-10-01");
    expect(summarizeFilters(fixed)).toContain("Fixed dates 2026-10-01 to 2026-10-19");
    expect(summarizeFilters(fixed)).toContain("Environment default");
  });

  it("rejects an unsupported store version and a view that is not a navigation record", () => {
    expect(parseSavedViewStore({ version: 2, views: [] })).toEqual({ views: [], dropped: 0 });
    expect(parseSavedViewStore({ version: 1, views: [{ id: "not-an-id", name: "Bad", destination: "https://evil.example", filters: {} }] }).dropped).toBe(1);
  });

  it("round-trips a restricted view without turning it into every incident", () => {
    const view: SavedView = {
      id: "8bc54506-889c-4fac-94bc-97314ef28ff1",
      name: "Default payments",
      destination: "incidents",
      filters: { service: "payments-api", environment: "default", queue: "all", application: null, range: null, from: null, to: null },
    };
    const parsed = parseSavedViewStore(JSON.parse(serializeSavedViews([view])));
    expect(parsed.views).toEqual([view]);
    expect(viewHref(view)).toBe("/dashboard/incidents?svc=payments-api&env=default");
  });
});

describe("pins", () => {
  it("rejects payloads and duplicate pins", () => {
    const pin = { kind: "incident" as const, id: "8bc54506-889c-4fac-94bc-97314ef28ff1", shortId: "8bc54506", method: "POST", path: "/payments", service: "payments-api", environment: "default" };
    expect(addPin([pin], pin)).toHaveLength(1);
    expect(parsePinStore({ version: 1, pins: [{ ...pin, body: { secret: "nope" } }] }).pins).toEqual([pin]);
    expect(parsePinStore({ version: 1, pins: [{ kind: "incident", id: pin.id, method: "POST", path: "/payments", requestBody: { amount: 1 } }] }).dropped).toBe(0);
    expect(pinKey(pin)).toBe(`incident:${pin.id}`);
  });

  it("drops a comparison of one revision with itself", () => {
    const id = "8bc54506-889c-4fac-94bc-97314ef28ff1";
    expect(parsePinStore({
      version: 1,
      pins: [{ kind: "comparison", service: "payments-api", environment: "default", leftId: id, rightId: id, leftVersion: "1.0.0", rightVersion: "1.0.0" }],
    }).dropped).toBe(1);
  });
});
