import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Run a statement that is expected to fail without leaving the Prisma/pg
 * connection in an aborted transaction state for follow-up queries.
 */
export async function expectSqlFailure(
  prisma: PrismaClient,
  run: (client: PrismaClient) => Promise<unknown>,
): Promise<void> {
  try {
    await run(prisma);
    throw new Error("Expected SQL statement to fail");
  } catch (error) {
    if (error instanceof Error && error.message === "Expected SQL statement to fail") {
      throw error;
    }
    // expected database error
  }
}
