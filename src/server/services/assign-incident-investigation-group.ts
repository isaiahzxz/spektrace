import { Prisma, ValidationStatus, type PrismaClient } from "@/generated/prisma/client";
import { normalizeHttpMethod } from "@/lib/validation/incident-envelope";
import { parseStoredValidationEvidence } from "@/lib/agent-evidence/parse-stored-evidence";
import {
  computeFindingSignature,
  resolveOperationIdentity,
  unresolvedOperationIdentityForIncident,
} from "@/lib/investigation/finding-signature";
import { groupingWindowForReceivedAt } from "@/lib/investigation/grouping-window";
import { groupingRevisionIdentity, senderGroupingIdentity, SENDER_GROUPING_VERSION } from "@/lib/investigation/sender-grouping";
import { scheduleGroupPreparationOutbox } from "@/lib/investigation/schedule-outbox";

const MAX_GROUPING_ATTEMPTS = 4;

export type AssignInvestigationGroupResult =
  | { status: "skipped"; reason: string }
  | {
      status: "assigned";
      investigationGroupId: string;
      membershipCreated: boolean;
      membershipVersion: number;
    };

export async function assignIncidentToInvestigationGroup(
  prisma: PrismaClient,
  workspaceId: string,
  incidentId: string,
): Promise<AssignInvestigationGroupResult> {
  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, workspaceId },
    include: { apiSpec: true, senderBinding: { include: { sender: true } } },
  });

  if (!incident) {
    return { status: "skipped", reason: "incident_not_found" };
  }

  if (incident.validationStatus === ValidationStatus.NOT_RUN) {
    return { status: "skipped", reason: "validation_not_ready" };
  }

  const parsed = parseStoredValidationEvidence(incident.validationEvidence);
  const scopeMatchedPath =
    parsed.format === "v1" ? parsed.scopeMatchedPath : null;
  const resolvedOperation = resolveOperationIdentity({
    parsedDocument: incident.apiSpec?.parsedDocument ?? null,
    httpMethod: incident.httpMethod,
    concreteRequestPath: incident.requestPath,
    scopeMatchedPath,
  });
  const operationIdentity =
    resolvedOperation === "__operation_unresolved__"
      ? unresolvedOperationIdentityForIncident(incident.id)
      : resolvedOperation;
  const findingSignature = computeFindingSignature(
    incident.validationStatus,
    incident.validationEvidence,
  );
  const window = groupingWindowForReceivedAt(incident.receivedAt);
  const httpMethod = normalizeHttpMethod(incident.httpMethod);
  const sender = senderGroupingIdentity(incident);
  const revision = groupingRevisionIdentity(incident);

  for (let attempt = 0; attempt < MAX_GROUPING_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const existingMembership = await tx.investigationGroupMembership.findUnique({
          where: { workspaceId_incidentId: { workspaceId, incidentId: incident.id } },
          include: { investigationGroup: true },
        });
        if (existingMembership) return {
          status: "assigned" as const, investigationGroupId: existingMembership.investigationGroupId,
          membershipCreated: false, membershipVersion: existingMembership.investigationGroup.membershipVersion,
        };
        let group = await tx.investigationGroup.findFirst({
          where: {
            workspaceId,
            apiKey: incident.apiKey,
            environment: incident.environment,
            httpMethod,
            operationIdentity,
            pinnedApiSpecKey: revision.pinnedApiSpecKey,
            groupingVersion: SENDER_GROUPING_VERSION,
            senderGroupingKey: sender.senderGroupingKey,
            findingSignature,
            windowStart: window.start,
          },
        });

        if (!group) {
          group = await tx.investigationGroup.create({
            data: {
              workspaceId,
              apiKey: incident.apiKey,
              environment: incident.environment,
              httpMethod,
              operationIdentity,
              apiSpecId: revision.apiSpecId,
              pinnedApiSpecKey: revision.pinnedApiSpecKey,
              groupingVersion: SENDER_GROUPING_VERSION,
              senderGroupingKey: sender.senderGroupingKey,
              senderId: sender.senderId,
              findingSignature,
              windowStart: window.start,
              windowEnd: window.end,
            },
          });
        }

        await tx.investigationGroupMembership.create({
          data: {
            workspaceId,
            investigationGroupId: group.id,
            incidentId: incident.id,
            incidentReceivedAt: incident.receivedAt,
          },
        });

        const updatedGroup = await tx.investigationGroup.update({
          where: { id: group.id },
          data: { membershipVersion: { increment: 1 } },
        });

        await scheduleGroupPreparationOutbox(tx, workspaceId, updatedGroup.id);

        return {
          status: "assigned",
          investigationGroupId: updatedGroup.id,
          membershipCreated: true,
          membershipVersion: updatedGroup.membershipVersion,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        continue;
      }
      throw error;
    }
  }

  return { status: "skipped", reason: "grouping_contention_exhausted" };
}
