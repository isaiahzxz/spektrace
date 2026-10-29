import "dotenv/config";
import { ValidationStatus } from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireDatabaseUrl } from "@/lib/env";
import { scheduleGroupingForIncidentIfReady } from "@/lib/investigation/schedule-outbox";

const DEFAULT_LIMIT = 100;

async function main() {
  const limit = Number(process.argv[2] ?? DEFAULT_LIMIT);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("Limit must be between 1 and 1000");
  }

  const prisma = createPrismaClientForUrl(requireDatabaseUrl());
  const incidents = await prisma.incident.findMany({
    where: {
      validationStatus: { not: ValidationStatus.NOT_RUN },
      investigationGroupMemberships: { none: {} },
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: { id: true, workspaceId: true },
  });

  let scheduled = 0;
  for (const incident of incidents) {
    await scheduleGroupingForIncidentIfReady(
      prisma,
      incident.workspaceId,
      incident.id,
    );
    scheduled += 1;
  }

  console.log(
    `[backfill-investigation-grouping] scheduled grouping for ${scheduled} incident(s) (limit ${limit})`,
  );
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("[backfill-investigation-grouping] failed", error);
  process.exit(1);
});
