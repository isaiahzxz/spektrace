import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import "server-only";
import type { ActorType, AuditEventType } from "@/generated/prisma/enums";
import { getPrisma } from "@/lib/db";
import { formatUtc } from "@/lib/dashboard/queue-query";
import { InternalConfigError } from "@/lib/internal-config";

const EVENT_LABEL: Record<AuditEventType, string> = {
  INTEGRATION_OBSERVATION_RECEIVED: "Integration observation received",
  INTEGRATION_BASELINE_CREATED: "Response baseline stored",
  INTEGRATION_BASELINE_ACTIVATED: "Response baseline selected",
  INTEGRATION_OUTCOME_RECEIVED: "Workflow outcome received",
  INCIDENT_RECEIVED: "Incident received",
  SPEC_REGISTERED: "API spec registered",
  SPEC_ACTIVATED: "API spec activated",
  VALIDATION_STARTED: "Body check started",
  VALIDATION_COMPLETED: "Body check finished",
  VALIDATION_FAILED: "Body check failed",
  DRAFT_GENERATED: "Draft generated",
  DRAFT_EDITED: "Draft edited",
  INCIDENT_APPROVED: "Incident approved",
  SEND_SUCCEEDED: "Send succeeded",
  SEND_FAILED: "Send failed",
  PATTERN_SEVERITY_SET: "Pattern severity set",
  REPOSITORY_SNAPSHOT_IMPORTED: "Repository snapshot imported",
  DOCUMENTATION_SNAPSHOT_IMPORTED: "Documentation snapshot imported",
  DEPLOYMENT_EVENT_RECORDED: "Deployment event recorded",
  HISTORICAL_BINDING_IMPORTED: "Historical contract binding imported",
  SENDER_BINDING_REGISTERED: "Sender binding registered",
  SENDER_BINDING_REVOKED: "Sender binding revoked",
  INGESTION_CREDENTIAL_ISSUED: "Ingestion credential issued",
  INGESTION_CREDENTIAL_REVOKED: "Ingestion credential revoked",
  INGESTION_CREDENTIAL_ROTATED: "Ingestion credential rotated",
};

function actorLabel(actorType: ActorType, actorId: string | null): string {
  if (actorId === "local-pilot") return "Local pilot operator";
  if (actorId) return `${actorType === "HUMAN" ? "Human" : "System"} ${actorId}`;
  return actorType === "HUMAN" ? "Human" : "System";
}


export type ActivityNotice = {
  id: string;
  at: string;
  label: string;
  actor: string;
  incidentId: string | null;
  failed: boolean;
};


export async function loadPilotActivity(limit = 12): Promise<{ workspaceId: string; notices: ActivityNotice[] }> {
  const workspaceId = (await getDashboardWorkspaceId());
  const rows = await getPrisma().auditLog.findMany({
    where: { workspaceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { id: true, eventType: true, actorType: true, actorId: true, incidentId: true, createdAt: true },
  });
  return {
    workspaceId,
    notices: rows.map((row) => ({
      id: row.id,
      at: formatUtc(row.createdAt) ?? "",
      label: EVENT_LABEL[row.eventType],
      actor: actorLabel(row.actorType, row.actorId),
      incidentId: row.incidentId,
      failed: row.eventType === "VALIDATION_FAILED" || row.eventType === "SEND_FAILED",
    })),
  };
}

export function headerFailureStatus(error: unknown): 404 | 503 {
  return error instanceof InternalConfigError ? 404 : 503;
}
