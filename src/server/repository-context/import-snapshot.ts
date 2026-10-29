import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AuditEventType,
  ActorType,
  RepositorySnapshotImportStatus,
  type Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import {
  findAllowlistEntry,
  loadRepositoryImportAllowlistFromEnv,
} from "@/lib/repository-context/allowlist";
import { REPOSITORY_CONTEXT_LIMITS } from "@/lib/repository-context/config";
import { computeRepositoryImportDigest, sha256Utf8 } from "@/lib/repository-context/import-digest";
import { normalizeRelativePath, pathAllowedByPrefix } from "@/lib/repository-context/paths";
import { sanitizeRepositorySourceText } from "@/lib/repository-context/sanitize-source";

const SERVICE = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ENV = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const REPO = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._\-/]+$/);

const provenanceSchema = z
  .object({
    ciRunId: z.string().trim().min(1).max(128).optional(),
    ciRunUrl: z.string().trim().url().max(300).refine((value) => value.startsWith("https://")).optional(),
  })
  .strict();

const fileSchema = z
  .object({
    relativePath: z.string().trim().min(1).max(REPOSITORY_CONTEXT_LIMITS.maxRelativePathLength),
    content: z.string(),
    sourceSha256: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
  })
  .strict();

export const repositoryContextImportSchema = z
  .object({
    apiKey: SERVICE,
    environment: ENV.optional(),
    repository: REPO,
    commitSha: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,64}$/i)
      .transform((value) => value.toLowerCase()),
    files: z.array(fileSchema).min(1).max(REPOSITORY_CONTEXT_LIMITS.maxFilesPerImport),
    provenance: provenanceSchema.optional(),
  })
  .strict();

export type RepositoryContextImportInput = z.infer<typeof repositoryContextImportSchema>;

export class RepositoryImportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RepositoryImportError";
  }
}

type PreparedFile = {
  relativePath: string;
  sourceSha256: string;
  sanitizedText: string;
  lineCount: number;
  redactionCount: number;
  omissionCodes: string[];
};

function auditMetadata(input: {
  repository: string;
  commitSha: string;
  apiKey: string;
  environment: string;
  fileCount: number;
  importStatus: RepositorySnapshotImportStatus;
  rejectedFileCount: number;
  importDigest: string;
}) {
  return {
    repository: input.repository,
    commitSha: input.commitSha,
    apiKey: input.apiKey,
    environment: input.environment,
    fileCount: input.fileCount,
    importStatus: input.importStatus,
    rejectedFileCount: input.rejectedFileCount,
    importDigest: input.importDigest,
  };
}

export async function importRepositoryContextSnapshot(
  prisma: PrismaClient,
  workspaceId: string,
  input: RepositoryContextImportInput,
) {
  const environment = input.environment ?? "default";
  const allowlist = loadRepositoryImportAllowlistFromEnv();
  const allowed = findAllowlistEntry(allowlist, {
    repository: input.repository,
    apiKey: input.apiKey,
    environment,
  });
  if (!allowed) {
    throw new RepositoryImportError("Repository import is not allowlisted for this service.", "NOT_ALLOWLISTED");
  }

  const seenPaths = new Set<string>();
  const prepared: PreparedFile[] = [];
  const rejected: Array<{ relativePath: string; code: string }> = [];
  let totalBytes = 0;

  for (const file of input.files) {
    const normalized = normalizeRelativePath(file.relativePath);
    if (!normalized.ok) {
      rejected.push({ relativePath: file.relativePath, code: normalized.code });
      continue;
    }
    if (seenPaths.has(normalized.path)) {
      rejected.push({ relativePath: normalized.path, code: "DUPLICATE_PATH" });
      continue;
    }
    seenPaths.add(normalized.path);

    if (!pathAllowedByPrefix(normalized.path, allowed.allowedPathPrefixes)) {
      rejected.push({ relativePath: normalized.path, code: "PATH_NOT_ALLOWED" });
      continue;
    }

    const contentBytes = Buffer.byteLength(file.content, "utf8");
    totalBytes += contentBytes;
    if (totalBytes > REPOSITORY_CONTEXT_LIMITS.maxTotalBytes) {
      rejected.push({ relativePath: normalized.path, code: "IMPORT_TOTAL_SIZE_EXCEEDED" });
      continue;
    }

    const expectedHash = file.sourceSha256?.toLowerCase() ?? sha256Utf8(file.content);
    if (file.sourceSha256 && expectedHash !== file.sourceSha256.toLowerCase()) {
      rejected.push({ relativePath: normalized.path, code: "SOURCE_HASH_MISMATCH" });
      continue;
    }

    const sanitized = sanitizeRepositorySourceText(file.content);
    if (!sanitized.ok) {
      rejected.push({ relativePath: normalized.path, code: sanitized.code });
      continue;
    }

    prepared.push({
      relativePath: normalized.path,
      sourceSha256: expectedHash,
      sanitizedText: sanitized.sanitizedText,
      lineCount: sanitized.lineCount,
      redactionCount: sanitized.redactionCount,
      omissionCodes: sanitized.omissionCodes,
    });
  }

  if (prepared.length === 0) {
    throw new RepositoryImportError("No importable files remained after validation.", "NO_IMPORTABLE_FILES");
  }

  const importDigest = computeRepositoryImportDigest(
    prepared.map((row) => ({ relativePath: row.relativePath, sourceSha256: row.sourceSha256 })),
  );

  const existing = await prisma.repositoryContextSnapshot.findFirst({
    where: {
      workspaceId,
      repository: input.repository,
      commitSha: input.commitSha,
      importDigest,
    },
  });
  if (existing) {
    return { snapshot: existing, created: false, rejected };
  }

  const importStatus =
    rejected.length > 0
      ? RepositorySnapshotImportStatus.PARTIAL
      : RepositorySnapshotImportStatus.COMPLETE;

  const omissionSummary = {
    rejectedFileCount: rejected.length,
    acceptedFileCount: prepared.length,
    totalRedactions: prepared.reduce((sum, row) => sum + row.redactionCount, 0),
    filesWithRedactions: prepared.filter((row) => row.redactionCount > 0).length,
  };

  const snapshotId = randomUUID();
  const provenance = {
    repository: input.repository,
    commitSha: input.commitSha,
    apiKey: input.apiKey,
    environment,
    ...(input.provenance ?? {}),
  };

  const snapshot = await prisma.$transaction(async (tx) => {
    const created = await tx.repositoryContextSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId,
        apiKey: input.apiKey,
        environment,
        repository: input.repository,
        commitSha: input.commitSha,
        importDigest,
        provenance: provenance as Prisma.InputJsonValue,
        importStatus,
        omissionSummary: omissionSummary as Prisma.InputJsonValue,
      },
    });

    await tx.repositorySnapshotFile.createMany({
      data: prepared.map((row) => ({
        id: randomUUID(),
        workspaceId,
        snapshotId: created.id,
        relativePath: row.relativePath,
        sourceSha256: row.sourceSha256,
        sanitizedText: row.sanitizedText,
        lineCount: row.lineCount,
        redactionCount: row.redactionCount,
        hadOmissions: row.omissionCodes.length > 0,
        omissionCodes: row.omissionCodes as Prisma.InputJsonValue,
      })),
    });

    await tx.auditLog.create({
      data: {
        workspaceId,
        eventType: AuditEventType.REPOSITORY_SNAPSHOT_IMPORTED,
        actorType: ActorType.SYSTEM,
        actorId: "repository-import",
        metadata: auditMetadata({
          repository: input.repository,
          commitSha: input.commitSha,
          apiKey: input.apiKey,
          environment,
          fileCount: prepared.length,
          importStatus,
          rejectedFileCount: rejected.length,
          importDigest,
        }) as Prisma.InputJsonValue,
      },
    });

    return created;
  });

  return { snapshot, created: true, rejected };
}
