import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { prepareVerificationGroup } from "../../scripts/lib/real-model-verification-harness";
import { submitIncident } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { assignIncidentToInvestigationGroup } from "@/server/services/assign-incident-investigation-group";
import { processEvidencePreparation } from "@/server/services/process-evidence-preparation";

vi.mock("@/server/services/incident-submission", () => ({ submitIncident: vi.fn() }));
vi.mock("@/server/services/process-incident-validation", () => ({ processIncidentValidation: vi.fn() }));
vi.mock("@/server/services/assign-incident-investigation-group", () => ({ assignIncidentToInvestigationGroup: vi.fn() }));
vi.mock("@/server/services/process-evidence-preparation", () => ({ processEvidencePreparation: vi.fn() }));

describe("verification case preparation selection (offline mocks)", () => {
  afterEach(() => vi.resetAllMocks());

  function setup() {
    vi.mocked(submitIncident).mockResolvedValue({ incident: { id: "new-case-incident" } } as Awaited<ReturnType<typeof submitIncident>>);
    vi.mocked(processIncidentValidation).mockResolvedValue({ status: "skipped", reason: "already_final" } as Awaited<ReturnType<typeof processIncidentValidation>>);
    vi.mocked(assignIncidentToInvestigationGroup).mockResolvedValue({ status: "assigned", investigationGroupId: "shared-group" } as Awaited<ReturnType<typeof assignIncidentToInvestigationGroup>>);
    vi.mocked(processEvidencePreparation).mockResolvedValue({ status: "processed", runId: "new-preparation", runStatus: "EVIDENCE_READY" });
    const findFirst = vi.fn().mockImplementation(async ({ where }) =>
      where.id === "new-preparation" && where.workspaceId === "fixture-workspace"
        ? { id: "new-preparation", status: "EVIDENCE_READY" }
        : { id: "old-preparation", status: "EVIDENCE_READY" },
    );
    const prisma = {
      incident: { findUnique: vi.fn().mockResolvedValue({ validationStatus: "MISMATCH" }) },
      evidencePreparationRun: { findFirst },
    };
    return { prisma: prisma as unknown as PrismaClient, findFirst };
  }

  it("uses the newly returned run rather than an older run from the shared group", async () => {
    const { prisma, findFirst } = setup();
    const result = await prepareVerificationGroup(prisma, "fixture-workspace", { amount: "12.5" }, 400);
    expect(result.prepId).toBe("new-preparation");
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "new-preparation", workspaceId: "fixture-workspace", investigationGroupId: "shared-group" } });
  });

  it("does not fall back to stale evidence when preparation is skipped", async () => {
    const { prisma, findFirst } = setup();
    vi.mocked(processEvidencePreparation).mockResolvedValue({ status: "skipped", reason: "group_not_found" });
    await expect(prepareVerificationGroup(prisma, "fixture-workspace", { amount: "12.5" }, 400)).rejects.toThrow("current case evidence was not prepared");
    expect(findFirst).not.toHaveBeenCalled();
  });
});
