"use server";
import { getDashboardWorkspaceId } from "@/server/accounts/workspace";

import { ActorType } from "@/generated/prisma/client";

import { getPrisma } from "@/lib/db";
import { LOCAL_PILOT_ACTOR } from "@/server/review/correction";
import { SpecActivationError, activateApiSpecRevision } from "@/server/repositories/api-specs";

export async function activateImportedRevision(formData: FormData) {
  if (process.env.NODE_ENV !== "development") {
    return { error: "Activation from this screen is available only in local development." };
  }
  const revisionId = String(formData.get("revisionId") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(revisionId) || confirm !== "activate") {
    return { error: "Confirm the service, environment, and revision before activation." };
  }
  try {
    await activateApiSpecRevision(getPrisma(), (await getDashboardWorkspaceId()), revisionId, {
      actorType: ActorType.HUMAN,
      actorId: LOCAL_PILOT_ACTOR,
    });
    return { error: null };
  } catch (error) {
    if (error instanceof SpecActivationError) return { error: error.message };
    return { error: "The revision was not activated." };
  }
}
