-- CreateEnum
CREATE TYPE "outbox_dispatch_status" AS ENUM ('PENDING', 'CLAIMED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "outbox_event_type" AS ENUM ('INCIDENT_VALIDATION_REQUESTED');

-- AlterTable
ALTER TABLE "incidents" ADD COLUMN "api_key" TEXT;

UPDATE "incidents" AS i
SET "api_key" = s."api_key"
FROM "api_specs" AS s
WHERE i."api_spec_id" = s."id" AND i."api_key" IS NULL;

UPDATE "incidents"
SET "api_key" = 'legacy-unknown'
WHERE "api_key" IS NULL;

ALTER TABLE "incidents" ALTER COLUMN "api_key" SET NOT NULL;

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "event_type" "outbox_event_type" NOT NULL DEFAULT 'INCIDENT_VALIDATION_REQUESTED',
    "dispatch_status" "outbox_dispatch_status" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMPTZ(6),
    "claim_expires_at" TIMESTAMPTZ(6),
    "claimed_by" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incidents_workspace_id_api_key_idx" ON "incidents"("workspace_id", "api_key");

-- CreateIndex
CREATE INDEX "outbox_events_dispatch_status_claim_expires_at_created_at_idx" ON "outbox_events"("dispatch_status", "claim_expires_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_workspace_id_incident_id_event_type_key" ON "outbox_events"("workspace_id", "incident_id", "event_type");

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_incident_id_fkey" FOREIGN KEY ("workspace_id", "incident_id") REFERENCES "incidents"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
