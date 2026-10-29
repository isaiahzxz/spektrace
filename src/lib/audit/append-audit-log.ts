import type { Prisma } from "@/generated/prisma/client";
import {
  ActorType,
  AuditEventType,
  type PrismaClient,
} from "@/generated/prisma/client";
import type { PrismaTransaction } from "@/lib/db";

export type AppendAuditLogInput = {
  workspaceId: string;
  incidentId?: string | null;
  eventType: AuditEventType;
  actorType: ActorType;
  actorId?: string | null;
  metadata: Prisma.InputJsonValue;
};

type DbLike = PrismaClient | PrismaTransaction;

export async function appendAuditLog(db: DbLike, input: AppendAuditLogInput) {
  return db.auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      incidentId: input.incidentId ?? null,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      metadata: input.metadata,
    },
  });
}
