import { z } from "zod";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { parseOpenApiSource } from "@/lib/openapi/document";
import { decideImport } from "@/lib/specs/revision-decisions";
import { registerApiSpec } from "@/server/repositories/api-specs";

const SERVICE = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ENV = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

const provenanceSchema = z
  .object({
    repository: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._\-/]+$/),
    commitSha: z.string().trim().regex(/^[0-9a-f]{7,64}$/i),
    openApiPath: z.string().trim().min(1).max(200).refine((value) => !value.includes("..") && !value.startsWith("/")),
    ciRunId: z.string().trim().min(1).max(128).optional(),
    ciRunUrl: z.string().trim().url().max(300).refine((value) => value.startsWith("https://")).optional(),
  })
  .strict();

export const specImportSchema = z
  .object({
    apiKey: SERVICE,
    environment: ENV.optional(),
    sourceFilename: z.string().trim().min(1).max(200),
    sourceText: z.string().min(2),
    provenance: provenanceSchema.optional(),
  })
  .strict();

export const specActivationSchema = z
  .object({
    apiSpecId: z.string().uuid(),
  })
  .strict();

export async function importSpecRevision(prisma: PrismaClient, workspaceId: string, input: z.infer<typeof specImportSchema>) {
  const parsed = parseOpenApiSource(input.sourceText);
  const environment = input.environment ?? "default";
  const existingHash = await prisma.apiSpec.findFirst({
    where: { workspaceId, apiKey: input.apiKey, environment, sourceSha256: parsed.sourceSha256 },
  });
  const decision = decideImport(
    existingHash ? { sourceSha256: existingHash.sourceSha256, version: existingHash.version } : null,
    { sourceSha256: parsed.sourceSha256, version: parsed.version },
  );
  if (decision === "replay" && existingHash) return { spec: existingHash, created: false };
  const versionClash = await prisma.apiSpec.findFirst({
    where: { workspaceId, apiKey: input.apiKey, environment, version: parsed.version },
  });
  if (versionClash && versionClash.sourceSha256 !== parsed.sourceSha256) {
    throw new Error("This version already exists with different content.");
  }
  try {
    const spec = await registerApiSpec(prisma, {
      workspaceId,
      apiKey: input.apiKey,
      environment,
      name: parsed.title,
      version: parsed.version,
      openApiVersion: parsed.openApiVersion,
      sourceFilename: input.sourceFilename,
      sourceText: input.sourceText,
      sourceSha256: parsed.sourceSha256,
      parsedDocument: parsed.document as Prisma.InputJsonValue,
      provenance: input.provenance ?? null,
      activate: false,
    });
    return { spec, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const replay = await prisma.apiSpec.findFirst({
        where: { workspaceId, apiKey: input.apiKey, environment, sourceSha256: parsed.sourceSha256 },
      });
      if (replay) return { spec: replay, created: false };
    }
    throw error;
  }
}
