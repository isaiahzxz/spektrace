import { describe, expect, it } from "vitest";
import {
  PRIMARY_NAV,
  dashboardDestination,
  coreCompatibilityHref,
  primaryDestination,
} from "@/lib/dashboard/mvp-navigation";
import {
  observationFilters,
  observationWhere,
  observationHref,
  observationEmptyState,
} from "@/lib/dashboard/observation-query";
describe("focused MVP navigation", () => {
  it("offers one core route set and maps supporting views to their parent", () => {
    expect(PRIMARY_NAV.map((link) => link.label)).toEqual([
      "Overview",
      "Integrations",
      "Observations",
    ]);
    expect(dashboardDestination({})).toBe("/dashboard");
    expect(primaryDestination("/dashboard")).toBe("/dashboard");
    expect(primaryDestination("/dashboard/webhooks/stripe")).toBe(
      "/dashboard/integrations",
    );
    expect(primaryDestination("/dashboard/incidents")).toBe(
      "/dashboard/observations",
    );
    expect(primaryDestination("/dashboard/audit")).toBe("/dashboard/settings");
  });
  it("preserves a legacy incident inspection without carrying arbitrary query data", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const href = dashboardDestination({
      incident: id,
      inspect: "1",
      env: "staging",
      token: "private-marker",
      next: "https://other.invalid",
    });
    expect(href).toContain("/dashboard/incidents?");
    const params = new URL(href, "http://local").searchParams;
    expect(params.get("incident")).toBe(id);
    expect(params.get("inspect")).toBe("1");
    expect(params.get("env")).toBe("staging");
    expect(href).not.toContain("private-marker");
    expect(href).not.toContain("other.invalid");
    expect(dashboardDestination({ incident: "malformed" })).toContain(
      "incident=invalid",
    );
  });
  it("keeps supported old scopes while disclosing removed consumer filters", () => {
    const href = coreCompatibilityHref(
      {
        application: "legacy-app",
        from: "2026-10-20",
        to: "2026-10-21",
        service: "crm",
        environment: "staging",
        page: "90",
      },
      "consumers",
    );
    const params = new URL(href, "http://local").searchParams;
    expect(params.get("from")).toBe("2026-10-20");
    expect(params.get("svc")).toBe("crm");
    expect(params.get("notice")).toBe("legacy-consumers");
    expect(params.has("application")).toBe(false);
    expect(params.has("page")).toBe(false);
    expect(coreCompatibilityHref({ svc: "crm", env: "staging" }, "specs")).toBe(
      "/dashboard/integrations?svc=crm&env=staging#request-contracts",
    );
  });
});
describe("observation filter boundaries and states", () => {
  it("rejects incomplete, invalid and reversed received-date ranges", () => {
    for (const value of [
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-10-20" },
      { from: "2026-10-21", to: "2026-10-20" },
    ])
      expect(observationFilters.safeParse(value).success).toBe(false);
  });
  it("uses inclusive UTC start and exclusive next-day end with tenant/provider scope", () => {
    const f = observationFilters.parse({
      svc: "crm",
      provider: "partner",
      env: "staging",
      from: "2026-10-20",
      to: "2026-10-20",
    });
    expect(observationWhere("tenant-a", f)).toEqual({
      workspaceId: "tenant-a",
      integrationKey: "crm",
      providerKey: "partner",
      environment: "staging",
      receivedAt: {
        gte: new Date("2026-10-20T00:00:00Z"),
        lt: new Date("2026-10-21T00:00:00Z"),
      },
    });
  });
  it("keeps finding/result distinctions and filters on later pages", () => {
    const f = observationFilters.parse({
      svc: "crm",
      env: "staging",
      provider: "partner",
      from: "2026-10-20",
      to: "2026-10-21",
      finding: "contract",
      http: "5xx",
    });
    expect(observationWhere("tenant", f)).toMatchObject({
      resultKind: "HTTP",
      statusCode: { gte: 500, lt: 600 },
      OR: [
        { detectorEvidence: { path: ["code"], equals: "CONTRACT_MISMATCH" } },
      ],
    });
    const params = new URL(observationHref(f, { page: 2 }), "http://local")
      .searchParams;
    for (const [key, value] of Object.entries({ ...f, page: 2 }))
      expect(params.get(key)).toBe(String(value));
    expect(
      observationWhere("tenant", {
        page: 1,
        finding: "no-response",
        http: "4xx",
      }).AND,
    ).toEqual([{ resultKind: "HTTP" }, { resultKind: { not: "HTTP" } }]);
  });
  it("distinguishes setup, awaiting capture, no matches and an empty later page", () => {
    const empty = {
      total: 0,
      scopeTotal: 0,
      workspaceTotal: 0,
      configuredCount: 0,
      coverageCount: 0,
    };
    expect(observationEmptyState(empty, { page: 1 })).toBe("setup");
    expect(
      observationEmptyState(
        { ...empty, configuredCount: 1 },
        { page: 1, svc: "crm" },
      ),
    ).toBe("waiting");
    expect(
      observationEmptyState(
        { ...empty, scopeTotal: 2, workspaceTotal: 2 },
        { page: 1, from: "2026-10-20", to: "2026-10-20" },
      ),
    ).toBe("filtered");
    expect(observationEmptyState({ ...empty, total: 20 }, { page: 2 })).toBe(
      "page",
    );
  });
});
