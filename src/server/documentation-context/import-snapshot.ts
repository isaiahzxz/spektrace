import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ActorType,
  AuditEventType,
  DocumentationSnapshotImportStatus,
  type Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import {
  findDocumentationAllowlistEntry,
  loadDocumentationImportAllowlistFromEnv,
} from "@/lib/documentation-context/allowlist";
import { DOCUMENTATION_CONTEXT_LIMITS } from "@/lib/documentation-context/config";
import {
  computeDocumentationImportDigest,
  sha256Utf8,
} from "@/lib/documentation-context/import-digest";
import { sanitizePlainTextContent } from "@/lib/protected-text/sanitize-plain-text";

const SERVICE = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ENV = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const SOURCE_KEY = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const DOC_ID = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

const applicabilitySchema = z
  .object({
    kind: z.enum(["unknown", "api_spec"]),
    apiSpecId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "api_spec" && !value.apiSpecId) {
      ctx.addIssue({ code: "custom", message: "apiSpecId required for api_spec applicability" });
    }
    if (value.kind === "unknown" && value.apiSpecId) {
      ctx.addIssue({ code: "custom", message: "apiSpecId must be omitted when applicability is unknown" });
    }
  });

const documentSchema = z
  .object({
    documentId: DOC_ID,
    title: z.string().trim().min(1).max(DOCUMENTATION_CONTEXT_LIMITS.maxTitleLength),
    contentFormat: z.enum(["markdown", "text"]),
    content: z.string().min(1),
    contentSha256: z.string().trim().regex(/^[0-9a-f]{64}$/i).optional(),
    contentVersion: z.string().trim().min(1).max(DOCUMENTATION_CONTEXT_LIMITS.maxContentVersionLength).optional(),
    sourceUpdatedAt: z.string().datetime().optional(),
  })
  .strict();

export const documentationContextImportSchema = z
  .object({
    sourceKey: SOURCE_KEY,
    apiKey: SERVICE,
    environment: ENV.optional(),
    documents: z.array(documentSchema).min(1).max(DOCUMENTATION_CONTEXT_LIMITS.maxDocumentsPerImport),
    applicability: applicabilitySchema.optional(),
  })
  .strict();

export type DocumentationContextImportInput = z.infer<typeof documentationContextImportSchema>;

export class DocumentationImportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DocumentationImportError";
  }
}

type PreparedDocument = {
  documentId: string;
  title: string;
  contentSha256: string;
  contentVersion: string | null;
  sourceUpdatedAt: Date | null;
  sanitizedText: string;
  lineCount: number;
  redactionCount: number;
  omissionCodes: string[];
  applicabilityKind: string;
  applicabilityApiSpecId: string | null;
  trustedSourceUrl: string | null;
};

export async function importDocumentationContextSnapshot(
  prisma: PrismaClient,
  workspaceId: string,
  input: DocumentationContextImportInput,
) {
  const environment = input.environment ?? "default";
  const allowlist = loadDocumentationImportAllowlistFromEnv();
  const allowed = findDocumentationAllowlistEntry(allowlist, {
    sourceKey: input.sourceKey,
    apiKey: input.apiKey,
    environment,
  });
  if (!allowed) {
    throw new DocumentationImportError("Documentation import is not allowlisted for this service.", "NOT_ALLOWLISTED");
  }

  const seen = new Set<string>();
  const prepared: PreparedDocument[] = [];
  const rejected: Array<{ documentId: string; code: string }> = [];
  let totalBytes = 0;

  for (const doc of input.documents) {
    if (seen.has(doc.documentId)) {
      rejected.push({ documentId: doc.documentId, code: "DUPLICATE_DOCUMENT_ID" });
      continue;
    }
    seen.add(doc.documentId);
    if (!allowed.allowedDocumentIds.includes(doc.documentId)) {
      rejected.push({ documentId: doc.documentId, code: "DOCUMENT_NOT_ALLOWED" });
      continue;
    }

    const bytes = Buffer.byteLength(doc.content, "utf8");
    totalBytes += bytes;
    if (totalBytes > DOCUMENTATION_CONTEXT_LIMITS.maxTotalBytes) {
      rejected.push({ documentId: doc.documentId, code: "IMPORT_TOTAL_SIZE_EXCEEDED" });
      continue;
    }

    const contentSha256 = doc.contentSha256?.toLowerCase() ?? sha256Utf8(doc.content);
    if (doc.contentSha256 && doc.contentSha256.toLowerCase() !== contentSha256) {
      rejected.push({ documentId: doc.documentId, code: "CONTENT_HASH_MISMATCH" });
      continue;
    }

    const sanitized = sanitizePlainTextContent(doc.content, DOCUMENTATION_CONTEXT_LIMITS.maxDocumentBytes);
    if (!sanitized.ok) {
      rejected.push({ documentId: doc.documentId, code: sanitized.code });
      continue;
    }

    let applicabilityKind = input.applicability?.kind ?? "unknown";
    let applicabilityApiSpecId = input.applicability?.apiSpecId ?? null;
    if (applicabilityKind === "api_spec" && applicabilityApiSpecId) {
      const spec = await prisma.apiSpec.findFirst({
        where: { id: applicabilityApiSpecId, workspaceId, apiKey: input.apiKey, environment },
      });
      if (!spec) {
        rejected.push({ documentId: doc.documentId, code: "APPLICABILITY_SCOPE_INVALID" });
        continue;
      }
    } else {
      applicabilityKind = "unknown";
      applicabilityApiSpecId = null;
    }

    prepared.push({
      documentId: doc.documentId,
      title: doc.title,
      contentSha256,
      contentVersion: doc.contentVersion ?? null,
      sourceUpdatedAt: doc.sourceUpdatedAt ? new Date(doc.sourceUpdatedAt) : null,
      sanitizedText: sanitized.sanitizedText,
      lineCount: sanitized.lineCount,
      redactionCount: sanitized.redactionCount,
      omissionCodes: sanitized.omissionCodes,
      applicabilityKind,
      applicabilityApiSpecId,
      trustedSourceUrl: allowed.trustedSourceUrls?.[doc.documentId] ?? null,
    });
  }

  if (prepared.length === 0) {
    throw new DocumentationImportError("No importable documents remained after validation.", "NO_IMPORTABLE_DOCUMENTS");
  }

  const importDigest = computeDocumentationImportDigest(
    prepared.map((row) => ({ documentId: row.documentId, contentSha256: row.contentSha256 })),
  );

  const existing = await prisma.documentationContextSnapshot.findFirst({
    where: { workspaceId, sourceKey: input.sourceKey, importDigest },
  });
  if (existing) {
    return { snapshot: existing, created: false, rejected };
  }

  const importStatus =
    rejected.length > 0
      ? DocumentationSnapshotImportStatus.PARTIAL
      : DocumentationSnapshotImportStatus.COMPLETE;

  const omissionSummary = {
    rejectedDocumentCount: rejected.length,
    acceptedDocumentCount: prepared.length,
    totalRedactions: prepared.reduce((sum, row) => sum + row.redactionCount, 0),
  };

  const snapshotId = randomUUID();
  const snapshot = await prisma.$transaction(async (tx) => {
    const created = await tx.documentationContextSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId,
        sourceKey: input.sourceKey,
        apiKey: input.apiKey,
        environment,
        importDigest,
        importStatus,
        omissionSummary: omissionSummary as Prisma.InputJsonValue,
      },
    });

    await tx.documentationSnapshotDocument.createMany({
      data: prepared.map((row) => ({
        id: randomUUID(),
        workspaceId,
        snapshotId: created.id,
        documentId: row.documentId,
        title: row.title,
        contentSha256: row.contentSha256,
        contentVersion: row.contentVersion,
        sourceUpdatedAt: row.sourceUpdatedAt,
        sanitizedText: row.sanitizedText,
        lineCount: row.lineCount,
        redactionCount: row.redactionCount,
        hadOmissions: row.omissionCodes.length > 0,
        omissionCodes: row.omissionCodes as Prisma.InputJsonValue,
        applicabilityKind: row.applicabilityKind,
        applicabilityApiSpecId: row.applicabilityApiSpecId,
        trustedSourceUrl: row.trustedSourceUrl,
      })),
    });

    await tx.auditLog.create({
      data: {
        workspaceId,
        eventType: AuditEventType.DOCUMENTATION_SNAPSHOT_IMPORTED,
        actorType: ActorType.SYSTEM,
        actorId: "documentation-import",
        metadata: {
          sourceKey: input.sourceKey,
          apiKey: input.apiKey,
          environment,
          documentCount: prepared.length,
          importStatus,
          rejectedDocumentCount: rejected.length,
          importDigest,
        } as Prisma.InputJsonValue,
      },
    });

    return created;
  });

  return { snapshot, created: true, rejected };
}
