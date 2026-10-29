import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { authorizeInternalRequest } from "@/lib/http/internal-api";
import { parseIngestionAuthorization } from "@/lib/ingestion/credential-token";
import {
  authenticateIngestionToken,
  IngestionUnauthorizedError,
} from "@/server/services/ingestion-credentials";
import {
  ingestIntegrationEvent,
  ingestWorkflowOutcome,
  IntegrationConflictError,
  IntegrationScopeError,
} from "@/server/integration-observations/ingest";
import { manageResponseBaseline } from "./baselines";

async function jsonBody(request: Request) {
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
      request.headers.get("content-type") ?? "",
    ) ||
    request.headers.has("content-encoding")
  )
    throw new TypeError("JSON required");
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Body required");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new TypeError("Body read deadline"));
    }, 2000);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 32768) {
        void reader.cancel().catch(() => {});
        throw new RangeError("Body too large");
      }
      chunks.push(part.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks),
      ),
    ) as unknown;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {}
  }
}
function failure(error: unknown) {
  const status =
    error instanceof IngestionUnauthorizedError
      ? 401
      : error instanceof IntegrationConflictError
        ? 409
        : error instanceof IntegrationScopeError
          ? 422
          : error instanceof RangeError
            ? 413
            : error instanceof z.ZodError ||
                error instanceof TypeError ||
                error instanceof SyntaxError
              ? 400
              : 503;
  return Response.json(
    {
      error:
        status === 401
          ? "Unauthorized"
          : status === 409
            ? "Event conflicts with retained evidence"
            : status === 422
              ? "Reference unsupported or unavailable in scope"
              : status === 413
                ? "Submission too large"
                : status === 400
                  ? "Invalid integration submission"
                  : "Service unavailable; acceptance not confirmed",
    },
    { status },
  );
}
export async function handleIntegrationIngestion(
  request: Request,
  db: PrismaClient,
  kind: "observation" | "outcome",
) {
  const auth = parseIngestionAuthorization(
    request.headers.get("authorization"),
  );
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await authenticateIngestionToken(db, auth.token);
    const input = await jsonBody(request);
    const result =
      kind === "observation"
        ? await ingestIntegrationEvent(db, auth.token, input)
        : await ingestWorkflowOutcome(db, auth.token, input);
    return Response.json(
      {
        id: result.id,
        created: result.created,
        meaning:
          "Stored evidence only; business success and causation are not established",
      },
      { status: result.created ? 202 : 200 },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function handleResponseBaseline(
  request: Request,
  db: PrismaClient,
) {
  const auth = authorizeInternalRequest(request.headers.get("authorization"));
  if (auth instanceof Response) return auth;
  try {
    const result = await manageResponseBaseline(
      db,
      auth.workspaceId,
      await jsonBody(request),
    );
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return failure(error);
  }
}
