SET lock_timeout = '5s';
SET statement_timeout = '30s';
ALTER TABLE "webhook_receipts" ADD COLUMN "sender_verification" JSONB;
