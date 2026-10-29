import "dotenv/config";
import { parseArgs } from "node:util";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { writeCredentialSecretFile } from "@/lib/ingestion/credential-secret-file";
import { issueIngestionCredential, revokeIngestionCredential, rotateIngestionCredential } from "@/server/services/ingestion-credentials";

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    workspace: { type: "string" }, id: { type: "string" }, name: { type: "string" }, "secret-file": { type: "string" },
  } });
  const command = positionals[0];
  const workspaceId = z.string().uuid().parse(values.workspace);
  const db = getPrisma();
  try {
    if (command === "list") {
      console.log(JSON.stringify(await db.ingestionCredential.findMany({ where: { workspaceId },
        select: { id: true, name: true, createdAt: true, expiresAt: true, revokedAt: true }, orderBy: { createdAt: "desc" } }), null, 2));
      return;
    }
    if (command === "revoke") {
      console.log(JSON.stringify(await revokeIngestionCredential(db, workspaceId, z.string().uuid().parse(values.id))));
      return;
    }
    if ((command !== "issue" && command !== "rotate") || !values["secret-file"]) throw new Error("Invalid command");
    const filename = values["secret-file"];
    const deliver = (material: { id: string; token: string }) => writeCredentialSecretFile(filename, material);
    const result = command === "issue"
      ? await issueIngestionCredential(db, workspaceId, values.name ?? "Application monitoring", deliver)
      : await rotateIngestionCredential(db, workspaceId, z.string().uuid().parse(values.id), deliver);
    console.log(JSON.stringify({ credential: result.credential, secretWritten: true }));
  } finally { await db.$disconnect(); }
}

main().catch(() => {
  console.error("Credential operation failed. No secret was printed. If a new secret file exists, retain it and check list before retrying; a database commit may be uncertain.");
  process.exitCode = 1;
});
