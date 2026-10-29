import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { REPOSITORY_CONTEXT_LIMITS } from "@/lib/repository-context/config";
import { recheckExcerptForExport } from "@/lib/repository-context/sanitize-source";

export const DEPLOYMENT_RELATIONSHIP_UNKNOWN =
  "Deployment relationship unknown unless separately recorded deployment evidence exists.";

export type RepositoryExcerptV1 = {
  id: string;
  snapshotId: string;
  repository: string;
  commitSha: string;
  relativeFilePath: string;
  startLine: number;
  endLine: number;
  sanitizedExcerpt: string;
  retrievalMethod: string;
  limitations: string[];
  deploymentRelationship: "unknown";
};

export type RetrieveRepositoryExcerptsInput = {
  workspaceId: string;
  apiKey: string;
  environment: string;
  httpMethod: string;
  operationPath: string | null;
  fieldTokens: string[];
};

export type RetrieveRepositoryExcerptsResult =
  | {
      ok: true;
      excerpts: RepositoryExcerptV1[];
      missingContext: string[];
      limitations: string[];
    }
  | { ok: false; code: string };

function excerptId(snapshotId: string, path: string, startLine: number, endLine: number): string {
  const digest = createHash("sha256")
    .update(`${snapshotId}\0${path}\0${startLine}\0${endLine}`, "utf8")
    .digest("hex")
    .slice(0, 10);
  return `rx-${digest}`;
}

function methodMatches(mappingMethod: string, httpMethod: string): boolean {
  if (mappingMethod === "*") {
    return true;
  }
  return mappingMethod.toUpperCase() === httpMethod.toUpperCase();
}

function findLineRangesForToken(text: string, token: string): Array<{ start: number; end: number }> {
  const lines = text.split(/\r?\n/);
  const ranges: Array<{ start: number; end: number }> = [];
  const context = REPOSITORY_CONTEXT_LIMITS.maxExcerptContextLines;

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]?.includes(token)) {
      continue;
    }
    const start = Math.max(1, i + 1 - context);
    const end = Math.min(lines.length, i + 1 + context);
    ranges.push({ start, end });
  }

  return ranges;
}

function mergeRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [sorted[0]!];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (current.start <= last.end + 1) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

export async function retrieveRepositoryExcerptsForSnapshot(
  prisma: PrismaClient,
  snapshotId: string,
  input: RetrieveRepositoryExcerptsInput,
): Promise<RetrieveRepositoryExcerptsResult> {
  const snapshot = await prisma.repositoryContextSnapshot.findFirst({
    where: { id: snapshotId, workspaceId: input.workspaceId },
    include: { files: true },
  });
  if (!snapshot) {
    return { ok: false, code: "SNAPSHOT_NOT_FOUND" };
  }
  if (snapshot.apiKey !== input.apiKey || snapshot.environment !== input.environment) {
    return { ok: false, code: "SNAPSHOT_SERVICE_MISMATCH" };
  }

  const mappings = await prisma.repositoryServiceFileMapping.findMany({
    where: {
      workspaceId: input.workspaceId,
      apiKey: input.apiKey,
      environment: input.environment,
    },
  });

  const operationPath = input.operationPath ?? "";
  const applicable = mappings.filter((row) => {
    if (!methodMatches(row.httpMethod, input.httpMethod)) {
      return false;
    }
    if (row.operationPath !== operationPath) {
      return false;
    }
    return true;
  });

  const missingContext: string[] = [];
  const limitations = [
    DEPLOYMENT_RELATIONSHIP_UNKNOWN,
    "Repository excerpts are heuristic matches against approved snapshot files; they do not establish causation.",
    "Secret detection in source is heuristic and does not guarantee safety.",
  ];

  if (applicable.length === 0) {
    missingContext.push("No service-to-file mappings are configured for this operation.");
    return { ok: true, excerpts: [], missingContext, limitations };
  }

  const excerpts: RepositoryExcerptV1[] = [];
  let aggregateBytes = 0;

  for (const mapping of applicable) {
    const file = snapshot.files.find((row) => row.relativePath === mapping.relativeFilePath);
    if (!file) {
      missingContext.push(`Mapped file ${mapping.relativeFilePath} is not present in the selected snapshot.`);
      continue;
    }

    const tokens =
      mapping.matchMode === "field_identifier" && mapping.identifierToken
        ? [mapping.identifierToken]
        : input.fieldTokens.filter(Boolean);

    if (tokens.length === 0) {
      missingContext.push(`Mapping ${mapping.relativeFilePath} requires field identifiers but none were supplied.`);
      continue;
    }

    const ranges: Array<{ start: number; end: number }> = [];
    for (const token of tokens) {
      ranges.push(...findLineRangesForToken(file.sanitizedText, token));
    }
    const merged = mergeRanges(ranges);
    if (merged.length === 0) {
      missingContext.push(`No matching implementation lines for ${mapping.relativeFilePath}.`);
      continue;
    }

    const lines = file.sanitizedText.split(/\r?\n/);
    for (const range of merged) {
      if (excerpts.length >= REPOSITORY_CONTEXT_LIMITS.maxExcerptsPerRetrieval) {
        limitations.push("Excerpt count limit reached; additional matches were omitted.");
        break;
      }
      const lineSpan = range.end - range.start + 1;
      if (lineSpan > REPOSITORY_CONTEXT_LIMITS.maxExcerptLines) {
        limitations.push(`Excerpt line span truncated for ${mapping.relativeFilePath}.`);
      }
      const endLine = Math.min(
        range.end,
        range.start + REPOSITORY_CONTEXT_LIMITS.maxExcerptLines - 1,
      );
      const slice = lines.slice(range.start - 1, endLine).join("\n");
      const checked = recheckExcerptForExport(slice);
      if (!checked.ok) {
        missingContext.push(`Could not export a safe excerpt for ${mapping.relativeFilePath}.`);
        continue;
      }
      const bytes = Buffer.byteLength(checked.text, "utf8");
      if (aggregateBytes + bytes > REPOSITORY_CONTEXT_LIMITS.maxAggregateExcerptUtf8Bytes) {
        limitations.push("Aggregate excerpt byte limit reached; additional excerpts were omitted.");
        break;
      }
      aggregateBytes += bytes;

      excerpts.push({
        id: excerptId(snapshot.id, file.relativePath, range.start, endLine),
        snapshotId: snapshot.id,
        repository: snapshot.repository,
        commitSha: snapshot.commitSha,
        relativeFilePath: file.relativePath,
        startLine: range.start,
        endLine: endLine,
        sanitizedExcerpt: checked.text,
        retrievalMethod: `mapping:${mapping.matchMode}`,
        limitations: [...limitations],
        deploymentRelationship: "unknown",
      });
    }
  }

  return { ok: true, excerpts, missingContext, limitations };
}
