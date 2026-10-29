import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { stripeProtectedShapeSchema } from "@/lib/ingestion/stripe-shape";

export async function processStripeWebhookValidation(db: PrismaClient, workspaceId: string, receiptId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM stripe_webhook_receipts WHERE id=${receiptId}::uuid AND workspace_id=${workspaceId}::uuid FOR UPDATE`;
    const row = await tx.stripeWebhookReceipt.findFirst({ where: { id: receiptId, workspaceId } });
    if (!row) return { status: "skipped", reason: "receipt_not_found" } as const;
    if (row.validationStatus !== "NOT_RUN") return { status: "skipped", reason: "already_completed" } as const;
    const valid = stripeProtectedShapeSchema.safeParse(row.protectedShape).success;
    await tx.stripeWebhookReceipt.update({ where: { id: row.id }, data: { validationStatus: "UNSUPPORTED", validatedAt: new Date(),
      validationEvidence: { version: 1, outcome: "UNSUPPORTED", scope: "structural_projection_only", businessProcessingConfirmed: false,
        reasonCode: valid ? "STRIPE_CONTRACT_NOT_CONFIGURED" : "STRIPE_PROTECTION_UNAVAILABLE",
        bodyValuesRetained: false, checkedAt: new Date().toISOString() } as Prisma.InputJsonValue } });
    return { status: "processed", validationStatus: "UNSUPPORTED" } as const;
  });
}
