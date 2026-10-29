"use server";
import { getDashboardWorkspaceId } from "@/server/accounts/workspace";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/db";

import { assignPatternSeverity, isPatternSeverity } from "@/server/review/severity";

export async function setPatternSeverity(patternKey: string, severity: string) {
  if (process.env.NODE_ENV !== "development") {
    return { ok: false, detail: "Severity changes run only in the local pilot." };
  }
  if (!isPatternSeverity(severity) || patternKey.length < 3 || patternKey.length > 500) {
    return { ok: false, detail: "That severity could not be saved." };
  }
  const result = await assignPatternSeverity(getPrisma(), (await getDashboardWorkspaceId()), { patternKey, severity });
  revalidatePath("/dashboard");
  return result;
}
