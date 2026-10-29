import { execSync } from "node:child_process";

export function deployMigrationsForUrl(databaseUrl: string): void {
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
}
