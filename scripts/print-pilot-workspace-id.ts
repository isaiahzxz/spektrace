import "dotenv/config";
import { createPrismaClientForUrl } from "../src/lib/db";
import { requireDatabaseUrl } from "../src/lib/env";

async function main() {
  const prisma = createPrismaClientForUrl(requireDatabaseUrl());
  const workspace = await prisma.workspace.findUnique({
    where: { slug: "demo-local" },
  });
  if (!workspace) {
    throw new Error('Demo workspace "demo-local" was not found. Run npm run db:seed first.');
  }
  console.log(workspace.id);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
