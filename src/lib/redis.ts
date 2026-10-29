import Redis from "ioredis";
import { requireRedisUrl } from "@/lib/env";

let producerRedis: Redis | null = null;
let workerRedis: Redis | null = null;

export function getProducerRedis(): Redis {
  if (!producerRedis) {
    producerRedis = new Redis(requireRedisUrl(), {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }
  return producerRedis;
}

export function getWorkerRedis(): Redis {
  if (!workerRedis) {
    workerRedis = new Redis(requireRedisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }
  return workerRedis;
}

export async function disconnectRedis(): Promise<void> {
  const clients = [producerRedis, workerRedis].filter(Boolean) as Redis[];
  producerRedis = null;
  workerRedis = null;
  await Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));
}
