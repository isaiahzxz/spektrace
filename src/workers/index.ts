import { runNotificationCycle } from "@/server/notifications/runner";
import "dotenv/config";
import { reconcileIntegrationOutbox } from "@/server/integration-observations/reconcile";
import { Worker } from "bullmq";
import {
  getIncidentQueueName,
  normalizeWorkerPayload,
  type IncidentJobPayload,
} from "@/lib/queue/job-types";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireDatabaseUrl, requireRedisUrl } from "@/lib/env";
import { getWorkerRedis, disconnectRedis } from "@/lib/redis";
import {
  dispatchOutboxBatch,
  recoverPublishedOutboxOrphans,
  reconcileWebhookOutbox,
} from "@/server/outbox/dispatcher";
import { routeWorkerJob } from "@/server/services/route-worker-job";

const DISPATCH_INTERVAL_MS = 1_000;

let shuttingDown = false;
let notificationBusy=false;
let nextNotificationRun=0;
let dispatchTimer: NodeJS.Timeout | null = null;
let worker: Worker<IncidentJobPayload> | null = null;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[spektrace-worker] received ${signal}, shutting down`);
  if (dispatchTimer) {
    clearInterval(dispatchTimer);
  }
  if (worker) {
    await worker.close();
  }
  await disconnectRedis();
  process.exit(0);
}

async function main() {
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  requireRedisUrl();
  const prisma = createPrismaClientForUrl(requireDatabaseUrl());

  worker = new Worker<IncidentJobPayload>(
    getIncidentQueueName(),
    async (job) => {
      const payload = normalizeWorkerPayload(job.data);
      const result = await routeWorkerJob(prisma, payload);
      return result;
    },
    {
      connection: getWorkerRedis(),
      concurrency: 2,
    },
  );

  worker.on("failed", (job, error) => {
    console.error(
      `[spektrace-worker] job failed ${job?.id ?? "unknown"}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  });

  dispatchTimer = setInterval(() => {
    void (async () => {
      try {
        await recoverPublishedOutboxOrphans(prisma);
        await reconcileWebhookOutbox(prisma);
        await reconcileIntegrationOutbox(prisma);
        await dispatchOutboxBatch(prisma);
        if(!notificationBusy && Date.now()>=nextNotificationRun){
          notificationBusy=true;nextNotificationRun=Date.now()+10000;
          void runNotificationCycle(prisma).catch(()=>console.error("[spektrace-worker] notification cycle unavailable; check destination configuration and migrations")).finally(()=>{notificationBusy=false;});
        }
      } catch (error) {
        console.error(
          `[spektrace-worker] outbox dispatch error: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    })();
  }, DISPATCH_INTERVAL_MS);

  console.log("[spektrace-worker] incident processor and outbox dispatcher running");
}

main().catch((error) => {
  console.error("[spektrace-worker] fatal error", error);
  process.exit(1);
});
