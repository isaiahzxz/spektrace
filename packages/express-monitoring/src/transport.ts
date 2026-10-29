import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type Delivery = "delivered" | "failed" | "timedOut" | "closed";

export function deliver(endpoint: URL, token: string, body: string, timeoutMs: number, signal: AbortSignal): Promise<Delivery> {
  return new Promise((resolve) => {
    let settled = false;
    const complete = (result: Delivery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    const request = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(endpoint, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body),
    } }, (response) => {
      complete(response.statusCode === 200 || response.statusCode === 202 ? "delivered" : "failed");
      response.destroy();
    });
    const cancel = () => { complete("closed"); req.destroy(); };
    req.on("error", () => complete("failed"));
    const timer = setTimeout(() => { complete("timedOut"); req.destroy(); }, timeoutMs);
    timer.unref();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel(); else req.end(body);
  });
}
