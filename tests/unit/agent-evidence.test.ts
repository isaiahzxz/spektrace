import { describe, expect, it } from "vitest";
import {
  IncidentSource,
  ValidationStatus,
  type PrismaClient,
} from "@/generated/prisma/client";
import { parseAgentEvidenceBundle } from "@/lib/agent-evidence/agent-evidence-v1";
import { AGENT_EVIDENCE_LIMITS } from "@/lib/agent-evidence/limits";
import { scanSerializedBundleForLeaks } from "@/lib/agent-evidence/outbound-scan";
import { sanitizeValidationFindings } from "@/lib/agent-evidence/sanitize-findings";
import { VALIDATION_EVIDENCE_VERSION } from "@/lib/validation/validation-evidence-v1";
import {
  AgentEvidenceBuildError,
  AgentEvidenceNotFoundError,
  AgentEvidenceReferenceMismatchError,
  buildAgentEvidenceBundle,
} from "@/server/services/build-agent-evidence";

const PAN_FIXTURE = "4111111111111111";
const SECRET_FIXTURE = "sk_live_fixture_do_not_export_abcdef0123456789";
let fixtureSequence = 0;
function randomUUID() {
  // Stable identifiers keep incidental digit runs from triggering the PAN scanner.
  return `aaaaaaaa-aaaa-4aaa-aaaa-${(++fixtureSequence).toString(16).padStart(12, "a")}`;
}

function makePrismaStub(incident: Record<string, unknown> | null): PrismaClient {
  return {
    incident: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; workspaceId: string };
      }) => {
        if (!incident) {
          return null;
        }
        if (incident.id !== where.id || incident.workspaceId !== where.workspaceId) {
          return null;
        }
        return incident;
      },
    },
  } as unknown as PrismaClient;
}

function baseIncident(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  const apiSpecId = randomUUID();
  return {
    id,
    workspaceId: "ws-a",
    apiKey: "payments-api",
    environment: "default",
    httpMethod: "POST",
    requestPath: "/payments",
    statusCode: 400,
    apiSpecId,
    validationStatus: ValidationStatus.MISMATCH,
    validationEvidence: {
      version: VALIDATION_EVIDENCE_VERSION,
      checkedAt: "2026-10-18T10:00:00.000Z",
      scope: {
        label: "openapi_request_body",
        openApiVersion: "3.1.0",
        matchedPath: "/payments",
        matchedMethod: "POST",
        covers: "json_request_body_only",
      },
      specRevision: { apiSpecId, sourceSha256: "sha-demo" },
      validator: { engine: "ajv", schemaDialect: "https://json-schema.org/draft/2020-12/schema" },
      outcome: ValidationStatus.MISMATCH,
      reasonCode: "SCHEMA_MISMATCH",
      reasonMessage: `Card ${PAN_FIXTURE} was rejected`,
      plainEnglishSummary: `Secret ${SECRET_FIXTURE} must not appear`,
      findings: [
        {
          jsonPointer: "/amount",
          keyword: "type",
          schemaPath: "#/properties/amount/type",
          message: `must be integer (card ${PAN_FIXTURE})`,
          expected: "integer",
          observedType: "number",
        },
        {
          jsonPointer: "/currency",
          keyword: "enum",
          schemaPath: "#/properties/currency/enum",
          message: "must be equal to one of the allowed values",
          allowedValues: ["usd", "eur", SECRET_FIXTURE],
        },
      ],
      redactedPaths: [],
    },
    sanitizedRequestBody: { amount: 12.5, card: PAN_FIXTURE, note: SECRET_FIXTURE },
    apiSpec: {
      id: apiSpecId,
      sourceSha256: "sha-demo",
      parsedDocument: {
        openapi: "3.1.0",
        paths: {
          "/payments": {
            post: { requestBody: { content: { "application/json": { schema: { type: "object" } } } } },
          },
        },
      },
    },
    ...overrides,
  };
}

describe("sanitizeValidationFindings", () => {
  it("keeps type and enum findings without exporting values or messages", () => {
    const { findings } = sanitizeValidationFindings([
      {
        jsonPointer: "/amount",
        keyword: "type",
        schemaPath: "#/properties/amount/type",
        message: `must be integer (card ${PAN_FIXTURE})`,
        expected: "integer",
        observedType: "number",
      },
      {
        jsonPointer: "/currency",
        keyword: "enum",
        schemaPath: "#/properties/currency/enum",
        message: `enum ${SECRET_FIXTURE}`,
        allowedValues: ["usd", SECRET_FIXTURE],
      },
    ]);

    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(PAN_FIXTURE);
    expect(serialized).not.toContain(SECRET_FIXTURE);
    expect(findings[0]).toMatchObject({
      ruleKeyword: "type",
      observedJsonType: "number",
      constraints: [{ kind: "expected_json_type", expectedJsonType: "integer" }],
    });
    expect(findings[1]?.constraints).toEqual([{ kind: "enum_value_count", allowedValueCount: 2 }]);
  });

  it("drops schema paths that reference examples or enums", () => {
    const { findings, omissions } = sanitizeValidationFindings([
      {
        jsonPointer: "/note",
        keyword: "type",
        schemaPath: "#/properties/note/examples/0",
        message: "bad",
        expected: "string",
      },
    ]);
    expect(findings).toHaveLength(0);
    expect(omissions.some((o) => o.code === "SCHEMA_RULE_PATH_SENSITIVE")).toBe(true);
  });
});

describe("buildAgentEvidenceBundle", () => {
  it("builds a schema-valid bundle without sensitive fixture values", async () => {
    const incident = baseIncident();
    const bundle = await buildAgentEvidenceBundle(
      makePrismaStub(incident),
      "ws-a",
      incident.id as string,
    );

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(PAN_FIXTURE);
    expect(serialized).not.toContain(SECRET_FIXTURE);
    expect(serialized).not.toContain("plainEnglishSummary");
    expect(serialized).not.toContain("sanitizedRequestBody");
    expect(scanSerializedBundleForLeaks(serialized)).toEqual({ safe: true });
    expect(parseAgentEvidenceBundle(bundle).ok).toBe(true);
    expect(bundle.http.operationPath).toBe("/payments");
    expect(bundle.findings.length).toBeGreaterThan(0);
  });

  it("omits unsafe concrete paths and prefers OpenAPI templates", async () => {
    const apiSpecId = randomUUID();
    const incident = baseIncident({
      requestPath: `/users/${randomUUID()}/profile`,
      validationEvidence: {
        ...baseIncident().validationEvidence,
        scope: {
          label: "openapi_request_body",
          matchedPath: `/users/${randomUUID()}/profile`,
          matchedMethod: "GET",
          covers: "json_request_body_only",
        },
        specRevision: { apiSpecId, sourceSha256: "sha-demo" },
        findings: [],
      },
      apiSpecId,
      apiSpec: {
        id: apiSpecId,
        sourceSha256: "sha-demo",
        parsedDocument: {
          openapi: "3.1.0",
          paths: {
            "/users/{userId}/profile": {
              get: { requestBody: { content: { "application/json": { schema: { type: "object" } } } } },
            },
          },
        },
      },
      httpMethod: "GET",
    });

    const bundle = await buildAgentEvidenceBundle(
      makePrismaStub(incident),
      "ws-a",
      incident.id as string,
    );
    expect(bundle.http.operationPath).toBe("/users/{userId}/profile");
    expect(bundle.http.operationPathOmissionCode).toBeNull();
  });

  it("omits paths that embed credentials", async () => {
    const apiSpecId = randomUUID();
    const incident = baseIncident({
      apiSpecId,
      requestPath: "/payments/token/secret-value",
      validationEvidence: {
        ...(baseIncident({ apiSpecId }).validationEvidence as object),
        scope: { matchedPath: "/payments/token/secret-value", covers: "json_request_body_only" },
        findings: [],
        specRevision: { apiSpecId, sourceSha256: "sha" },
      },
      apiSpec: { id: apiSpecId, sourceSha256: "sha", parsedDocument: { paths: {} } },
    });

    const bundle = await buildAgentEvidenceBundle(
      makePrismaStub(incident),
      "ws-a",
      incident.id as string,
    );
    expect(bundle.http.operationPath).toBeNull();
    expect(bundle.http.operationPathOmissionCode).toBeTruthy();
  });

  it("rejects cross-workspace access as not found", async () => {
    const incident = baseIncident({ workspaceId: "ws-b" });
    await expect(
      buildAgentEvidenceBundle(makePrismaStub(incident), "ws-a", incident.id as string),
    ).rejects.toBeInstanceOf(AgentEvidenceNotFoundError);
  });

  it("rejects mismatched specification references", async () => {
    const incident = baseIncident({
      apiSpecId: randomUUID(),
    });
    await expect(
      buildAgentEvidenceBundle(makePrismaStub(incident), "ws-a", incident.id as string),
    ).rejects.toBeInstanceOf(AgentEvidenceReferenceMismatchError);
  });

  it("fails safely on malformed evidence", async () => {
    const incident = baseIncident({ validationEvidence: { version: 2, findings: [] } });
    await expect(
      buildAgentEvidenceBundle(makePrismaStub(incident), "ws-a", incident.id as string),
    ).rejects.toBeInstanceOf(AgentEvidenceBuildError);
  });

  it("truncates oversized finding lists", async () => {
    const apiSpecId = randomUUID();
    const manyFindings = Array.from({ length: AGENT_EVIDENCE_LIMITS.maxFindings + 5 }, (_, i) => ({
      jsonPointer: `/field${i}`,
      keyword: "type",
      schemaPath: `#/properties/field${i}/type`,
      message: "must be integer",
      expected: "integer",
      observedType: "string",
    }));

    const incident = baseIncident({
      apiSpecId,
      validationEvidence: {
        ...(baseIncident({ apiSpecId }).validationEvidence as object),
        findings: manyFindings,
        specRevision: { apiSpecId, sourceSha256: "sha-demo" },
      },
      apiSpec: {
        id: apiSpecId,
        sourceSha256: "sha-demo",
        parsedDocument: baseIncident({ apiSpecId }).apiSpec.parsedDocument,
      },
    });

    const bundle = await buildAgentEvidenceBundle(
      makePrismaStub(incident),
      "ws-a",
      incident.id as string,
    );
    expect(bundle.findings.length).toBe(AGENT_EVIDENCE_LIMITS.maxFindings);
    expect(bundle.protection.outputTruncated).toBe(true);
  });

  it("records redaction-blocked validation without exporting body fields", async () => {
    const apiSpecId = randomUUID();
    const incident = baseIncident({
      apiSpecId,
      validationStatus: ValidationStatus.UNSUPPORTED,
      validationEvidence: {
        ...(baseIncident({ apiSpecId }).validationEvidence as object),
        outcome: ValidationStatus.UNSUPPORTED,
        reasonCode: "REDACTION_BLOCKED_VALIDATION",
        findings: [],
        redactedPaths: ["/apiKey"],
        specRevision: { apiSpecId, sourceSha256: "sha-demo" },
      },
      apiSpec: {
        id: apiSpecId,
        sourceSha256: "sha-demo",
        parsedDocument: baseIncident({ apiSpecId }).apiSpec.parsedDocument,
      },
    });

    const bundle = await buildAgentEvidenceBundle(
      makePrismaStub(incident),
      "ws-a",
      incident.id as string,
    );
    expect(bundle.protection.redactionBlockedValidation).toBe(true);
    expect(bundle.protection.evidenceComplete).toBe(false);
    expect(JSON.stringify(bundle)).not.toContain(PAN_FIXTURE);
  });
});
