import type { PrismaClient } from "@/generated/prisma/client";
import type { PrismaTransaction } from "@/lib/db";

type Db = PrismaClient | PrismaTransaction;

export async function getWorkspaceBySlug(db: Db, slug: string) {
  return db.workspace.findUnique({ where: { slug } });
}

export async function getWorkspaceById(db: Db, workspaceId: string) {
  return db.workspace.findUnique({ where: { id: workspaceId } });
}
