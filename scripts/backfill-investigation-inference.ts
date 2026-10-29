import "dotenv/config";
import { EvidencePreparationRunStatus } from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireDatabaseUrl } from "@/lib/env";
import { isAiInvestigationEnabledForWorkspace } from "@/lib/investigation/inference/config";
import { scheduleGroupInferenceOutbox } from "@/lib/investigation/schedule-outbox";

const DEFAULT_LIMIT = 50;

async function main() {
  const limit = Number(process.argv[2] ?? DEFAULT_LIMIT);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
    throw new Error("Limit must be between 1 and 500");
  }

  const prisma = createPrismaClientForUrl(requireDatabaseUrl());
  const readyRuns = await prisma.evidencePreparationRun.findMany({
    where: { status: EvidencePreparationRunStatus.EVIDENCE_READY },
    orderBy: { completedAt: "asc" },
    take: limit,
    select: {
      id: true,
      workspaceId: true,
      investigationGroupId: true,
    },
  });

  let scheduled = 0;
  for (const run of readyRuns) {
    if (!isAiInvestigationEnabledForWorkspace(run.workspaceId)) {
      continue;
    }
    const existing = await prisma.investigationInferenceRun.findFirst({
      where: {
        workspaceId: run.workspaceId,
        evidencePreparationRunId: run.id,
        status: "SUCCEEDED",
      },
    });
    if (existing) {
      continue;
    }
    await prisma.$transaction(async (tx) => {
      await scheduleGroupInferenceOutbox(
        tx,
        run.workspaceId,
        run.investigationGroupId,
        run.id,
      );
    });
    scheduled += 1;
  }

  console.log(
    `[backfill-investigation-inference] scheduled inference for ${scheduled} preparation run(s) (scanned ${readyRuns.length}, limit ${limit})`,
  );
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("[backfill-investigation-inference] failed", error);
  process.exit(1);
});
