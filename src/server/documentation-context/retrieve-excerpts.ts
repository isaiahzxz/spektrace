import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  DOCUMENTATION_AUTHORITY_NOTE,
  DOCUMENTATION_CONTEXT_LIMITS,
  DOCUMENTATION_FRESHNESS_NOTE,
} from "@/lib/documentation-context/config";
import { recheckPlainTextExcerpt } from "@/lib/protected-text/sanitize-plain-text";

export type DocumentationExcerptV1 = {
  id: string;
  snapshotId: string;
  documentId: string;
  title: string;
  contentSha256: string;
  contentVersion: string | null;
  sectionHeading: string;
  startLine: number;
  endLine: number;
  sanitizedExcerpt: string;
  applicability: {
    kind: "unknown" | "api_spec";
    apiSpecId: string | null;
    status: "unknown" | "declared" | "mismatched_pinned_spec";
  };
  retrievalMethod: string;
  limitations: string[];
  trustedSourceUrl: string | null;
};

export type RetrieveDocumentationExcerptsInput = {
  workspaceId: string;
  apiKey: string;
  environment: string;
  httpMethod: string;
  operationPath: string | null;
  pinnedApiSpecId: string | null;
  fieldTokens: string[];
};

export type RetrieveDocumentationExcerptsResult =
  | {
      ok: true;
      excerpts: DocumentationExcerptV1[];
      missingContext: string[];
      limitations: string[];
    }
  | { ok: false; code: string };

function excerptId(
  snapshotId: string,
  documentId: string,
  sectionHeading: string,
  startLine: number,
  endLine: number,
): string {
  const digest = createHash("sha256")
    .update(`${snapshotId}\0${documentId}\0${sectionHeading}\0${startLine}\0${endLine}`, "utf8")
    .digest("hex")
    .slice(0, 10);
  return `dx-${digest}`;
}

function methodMatches(mappingMethod: string, httpMethod: string): boolean {
  return mappingMethod === "*" || mappingMethod.toUpperCase() === httpMethod.toUpperCase();
}

function findSectionRange(
  text: string,
  sectionHeading: string,
): { startLine: number; endLine: number; heading: string } | null {
  const lines = text.split(/\r?\n/);
  const normalizedTarget = sectionHeading.trim().toLowerCase();
  let startIndex = -1;
  let heading = sectionHeading;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const mdHeading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (mdHeading) {
      const label = mdHeading[1]!.trim();
      if (label.toLowerCase() === normalizedTarget || label.toLowerCase().includes(normalizedTarget)) {
        startIndex = i;
        heading = label;
        break;
      }
    } else if (line.trim().toLowerCase() === normalizedTarget) {
      startIndex = i;
      heading = line.trim();
      break;
    }
  }

  if (startIndex < 0) {
    return null;
  }

  let endIndex = lines.length - 1;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^#{1,6}\s+/.test(line)) {
      endIndex = i - 1;
      break;
    }
  }

  return { startLine: startIndex + 1, endLine: endIndex + 1, heading };
}

function sectionMentionsTokens(sectionText: string, tokens: string[]): boolean {
  if (tokens.length === 0) {
    return true;
  }
  return tokens.some((token) => sectionText.includes(token));
}

export async function retrieveDocumentationExcerptsForSnapshot(
  prisma: PrismaClient,
  snapshotId: string,
  input: RetrieveDocumentationExcerptsInput,
): Promise<RetrieveDocumentationExcerptsResult> {
  const snapshot = await prisma.documentationContextSnapshot.findFirst({
    where: { id: snapshotId, workspaceId: input.workspaceId },
    include: { documents: true },
  });
  if (!snapshot) {
    return { ok: false, code: "SNAPSHOT_NOT_FOUND" };
  }
  if (snapshot.apiKey !== input.apiKey || snapshot.environment !== input.environment) {
    return { ok: false, code: "SNAPSHOT_SERVICE_MISMATCH" };
  }

  const mappings = await prisma.documentationServiceTopicMapping.findMany({
    where: { workspaceId: input.workspaceId, apiKey: input.apiKey, environment: input.environment },
  });

  const operationPath = input.operationPath ?? "";
  const applicable = mappings.filter(
    (row) => methodMatches(row.httpMethod, input.httpMethod) && row.operationPath === operationPath,
  );

  const limitations = [
    DOCUMENTATION_FRESHNESS_NOTE,
    DOCUMENTATION_AUTHORITY_NOTE,
    "Heuristic secret scanning does not guarantee documentation is safe to export.",
  ];
  const missingContext: string[] = [];

  if (applicable.length === 0) {
    missingContext.push("No documentation topic mappings are configured for this operation.");
    return { ok: true, excerpts: [], missingContext, limitations };
  }

  const excerpts: DocumentationExcerptV1[] = [];
  let aggregateBytes = 0;

  for (const mapping of applicable) {
    const document = snapshot.documents.find((row) => row.documentId === mapping.documentId);
    if (!document) {
      missingContext.push(`Mapped document ${mapping.documentId} is not present in the selected snapshot.`);
      continue;
    }

    const range = findSectionRange(document.sanitizedText, mapping.sectionHeading);
    if (!range) {
      missingContext.push(`Section "${mapping.sectionHeading}" was not found in ${mapping.documentId}.`);
      continue;
    }

    const lines = document.sanitizedText.split(/\r?\n/);
    const sectionText = lines.slice(range.startLine - 1, range.endLine).join("\n");
    const tokens =
      mapping.matchMode === "topic_token" && mapping.topicToken
        ? [mapping.topicToken]
        : input.fieldTokens;
    if (!sectionMentionsTokens(sectionText, tokens)) {
      missingContext.push(`Section "${mapping.sectionHeading}" does not mention the requested topic tokens.`);
      continue;
    }

    const endLine = Math.min(
      range.endLine,
      range.startLine + DOCUMENTATION_CONTEXT_LIMITS.maxExcerptLines - 1,
    );
    const slice = lines.slice(range.startLine - 1, endLine).join("\n");
    const checked = recheckPlainTextExcerpt(slice, DOCUMENTATION_CONTEXT_LIMITS.maxExcerptUtf8Bytes);
    if (!checked.ok) {
      missingContext.push(`Could not export a safe excerpt for ${mapping.documentId}.`);
      continue;
    }

    const bytes = Buffer.byteLength(checked.text, "utf8");
    if (aggregateBytes + bytes > DOCUMENTATION_CONTEXT_LIMITS.maxAggregateExcerptUtf8Bytes) {
      limitations.push("Aggregate documentation excerpt byte limit reached.");
      break;
    }
    if (excerpts.length >= DOCUMENTATION_CONTEXT_LIMITS.maxExcerptsPerRetrieval) {
      limitations.push("Documentation excerpt count limit reached.");
      break;
    }
    aggregateBytes += bytes;

    let applicabilityStatus: DocumentationExcerptV1["applicability"]["status"] = "unknown";
    if (document.applicabilityKind === "api_spec" && document.applicabilityApiSpecId) {
      applicabilityStatus = "declared";
      if (input.pinnedApiSpecId && input.pinnedApiSpecId !== document.applicabilityApiSpecId) {
        applicabilityStatus = "mismatched_pinned_spec";
        limitations.push(
          "Documentation declares applicability to a different API specification revision than the incident group pin.",
        );
      }
    }

    excerpts.push({
      id: excerptId(snapshot.id, document.documentId, range.heading, range.startLine, endLine),
      snapshotId: snapshot.id,
      documentId: document.documentId,
      title: document.title,
      contentSha256: document.contentSha256,
      contentVersion: document.contentVersion,
      sectionHeading: range.heading,
      startLine: range.startLine,
      endLine,
      sanitizedExcerpt: checked.text,
      applicability: {
        kind: document.applicabilityKind === "api_spec" ? "api_spec" : "unknown",
        apiSpecId: document.applicabilityApiSpecId,
        status: applicabilityStatus,
      },
      retrievalMethod: `mapping:${mapping.matchMode}`,
      limitations: [...limitations],
      trustedSourceUrl: document.trustedSourceUrl,
    });
  }

  return { ok: true, excerpts, missingContext, limitations };
}
