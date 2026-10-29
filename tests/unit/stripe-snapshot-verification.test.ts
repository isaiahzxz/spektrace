import { createHmac, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStripeTestSnapshotVerifier, readProtectedStripeSnapshot, readVerifiedStripeSnapshotMetadata, StripeVerificationError,
  STRIPE_SNAPSHOT_LIMITS, type StripeTestEndpointConfig, type StripeVerificationCode } from "@/server/webhooks/stripe-snapshot-verification";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T18:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function config(): StripeTestEndpointConfig {
  return { workspaceId: randomUUID(), integrationId: randomUUID(), mode: "test", secrets: [
    { id: randomUUID(), value: `whsec_${randomBytes(32).toString("hex")}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  ] };
}
function event(overrides: Record<string, unknown> = {}) {
  return { id: `evt_${randomUUID().replaceAll("-", "")}`, object: "event", type: "payment_intent.payment_failed",
    created: 1_600_000_000, livemode: false, api_version: "2024-06-20", data: { object: { object: "payment_intent" } }, ...overrides };
}
// Independent protocol fixtures: no Stripe SDK signature generator or verifier helpers.
function headers(body: Buffer, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  return ["Stripe-Signature", `t=${timestamp},v1=${digest}`];
}
function rejection(fn: () => unknown, code: StripeVerificationCode) {
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(StripeVerificationError);
  expect(caught).toMatchObject({ code, message: "Stripe snapshot verification rejected" });
  return caught;
}

describe("Stripe snapshot metadata boundary", () => {
  it("verifies independent signed fixtures and exposes only bounded metadata from configured scope", () => {
    const c = config(); const verify = createStripeTestSnapshotVerifier(c);
    const privateMarker = `private-${randomUUID()}@example.test`;
    const input = event({ workspaceId: randomUUID(), request: { idempotency_key: privateMarker },
      data: { object: { object: "payment_intent", id: "pi_private", customer: "cus_private", receipt_email: privateMarker, client_secret: privateMarker } } });
    const raw = Buffer.from(JSON.stringify(input)); const original = Buffer.from(raw);
    const proof = verify([...headers(raw, c.secrets[0].value), "X-Workspace-Id", randomUUID(), "X-Client-Id", "spoofed"], raw);
    const result = readVerifiedStripeSnapshotMetadata(proof);
    expect(JSON.stringify(result), "metadata must omit the run-unique private body marker").not.toContain(privateMarker);
    expect(result).toEqual({ provider: "stripe", format: "snapshot", workspaceId: c.workspaceId, integrationId: c.integrationId,
      signingSecretId: c.secrets[0].id, eventId: input.id, eventType: "payment_intent.payment_failed",
      eventCreatedAt: new Date(input.created * 1000).toISOString(), reportedApiVersion: "2024-06-20", livemode: false,
      signatureTimestamp: Math.floor(Date.now() / 1000), verifiedAt: new Date().toISOString(),
      verificationBasis: "configured_endpoint_secret_possession", businessProcessingConfirmed: false });
    expect(JSON.stringify(result)).not.toContain("pi_private"); expect(JSON.stringify(result)).not.toContain("cus_private");
    expect(JSON.stringify(result)).not.toContain(c.secrets[0].value);
    expect(raw).toEqual(original); raw.fill(0); expect(result.eventId).toBe(input.id);
    expect(Reflect.set(result, "workspaceId", randomUUID())).toBe(false);
    rejection(() => readVerifiedStripeSnapshotMetadata(JSON.parse(JSON.stringify(proof))), "UNKNOWN_PROOF");
    rejection(() => readVerifiedStripeSnapshotMetadata(result), "UNKNOWN_PROOF");
  });

  it("preserves Unicode and whitespace signed as original bytes with a WebCrypto reference", async () => {
    const c = config(); const verify = createStripeTestSnapshotVerifier(c);
    const raw = Buffer.from(JSON.stringify(event({ data: { object: { object: "payment_intent", description: "café 雪" } } }), null, 2));
    const timestamp = Math.floor(Date.now() / 1000);
    const key = await webcrypto.subtle.importKey("raw", Buffer.from(c.secrets[0].value), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = Buffer.from(await webcrypto.subtle.sign("HMAC", key, Buffer.concat([Buffer.from(`${timestamp}.`), raw]))).toString("hex");
    const h = ["Stripe-Signature", `t=${timestamp},v1=${digest}`];
    expect(readVerifiedStripeSnapshotMetadata(verify(h, raw)).provider).toBe("stripe");
    rejection(() => verify(h, Buffer.from(JSON.stringify(JSON.parse(raw.toString())))), "SIGNATURE_INVALID");
    rejection(() => verify(h, Buffer.concat([raw, Buffer.from(" ")])), "SIGNATURE_INVALID");
    const altered = Buffer.from(raw); altered[10] ^= 1;
    rejection(() => verify(h, altered), "SIGNATURE_INVALID");
  });

  it("accepts valid rotated secrets and any matching v1 without accepting unknown secrets or v0 alone", () => {
    const c = config(); const previous = config().secrets[0]; c.secrets.push(previous);
    const verify = createStripeTestSnapshotVerifier(c), raw = Buffer.from(JSON.stringify(event()));
    const good = headers(raw, previous.value);
    good[1] += `,v1=${"0".repeat(64)},v0=ignored`;
    expect(readVerifiedStripeSnapshotMetadata(verify(good, raw)).signingSecretId).toBe(previous.id);
    rejection(() => verify(headers(raw, config().secrets[0].value), raw), "SIGNATURE_INVALID");
    rejection(() => verify(["Stripe-Signature", headers(raw, previous.value)[1].replace("v1=", "v0=")], raw), "INVALID_HEADERS");
  });

  it("enforces exact past and future clock boundaries independently of event.created", () => {
    const c = config(), verify = createStripeTestSnapshotVerifier(c), raw = Buffer.from(JSON.stringify(event()));
    const now = Math.floor(Date.now() / 1000);
    for (const delta of [-300, 0, 30]) expect(readVerifiedStripeSnapshotMetadata(verify(headers(raw, c.secrets[0].value, now + delta), raw)).eventCreatedAt)
      .toBe(new Date(1_600_000_000_000).toISOString());
    for (const delta of [-301, 31]) rejection(() => verify(headers(raw, c.secrets[0].value, now + delta), raw), "TIMESTAMP_OUT_OF_RANGE");
  });

  it("checks configured secret expiry on every verification and snapshots caller configuration", () => {
    const c = config(); c.secrets[0].expiresAt = new Date(Date.now() + 1000).toISOString();
    const workspaceId = c.workspaceId, secret = c.secrets[0].value;
    const verify = createStripeTestSnapshotVerifier(c); c.workspaceId = randomUUID(); c.secrets[0].value = config().secrets[0].value;
    const raw = Buffer.from(JSON.stringify(event()));
    expect(readVerifiedStripeSnapshotMetadata(verify(headers(raw, secret), raw)).workspaceId).toBe(workspaceId);
    vi.advanceTimersByTime(1000);
    rejection(() => verify(headers(raw, secret), raw), "SIGNING_KEY_UNAVAILABLE");
  });

  it("rejects duplicated, ambiguous, malformed and oversized signature headers", () => {
    const c = config(), verify = createStripeTestSnapshotVerifier(c), raw = Buffer.from(JSON.stringify(event())); const good = headers(raw, c.secrets[0].value);
    const atHeaderLimit = [good[0], " ".repeat(2048 - good[1].length) + good[1]];
    expect(readVerifiedStripeSnapshotMetadata(verify(atHeaderLimit, raw)).provider).toBe("stripe");
    for (const h of [[], ["Stripe-Signature"], [...good, ...good], ["stripe-signature", good[1], "STRIPE-SIGNATURE", good[1]],
      ["Stripe-Signature", `${good[1]},t=${Math.floor(Date.now() / 1000)}`], ["Stripe-Signature", good[1].replace("t=", "t=0")],
      ["Stripe-Signature", good[1].replace("v1=", "v1=bad")], ["Stripe-Signature", `${good[1]},garbage`],
      ["Stripe-Signature", "x".repeat(STRIPE_SNAPSHOT_LIMITS.headerBytes + 1)],
      ["Stripe-Signature", good[1] + `,v1=${"0".repeat(64)}`.repeat(5)],
      [...good, ...Array.from({ length: 128 }, () => "other")]])
      rejection(() => verify(h, raw), "INVALID_HEADERS");
  });

  it("rejects signed malformed JSON, non-object and incomplete envelopes without input leakage", () => {
    const c = config(), verify = createStripeTestSnapshotVerifier(c); const marker = `unique-private-${randomUUID()}`;
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    for (const raw of [Buffer.from(`{"secret":"${marker}",broken`), Buffer.from("[]"), Buffer.from("null"),
      Buffer.from(JSON.stringify(event({ data: null }))), Buffer.from(JSON.stringify(event({ livemode: "false" }))),
      Buffer.from(JSON.stringify(event({ api_version: marker }))), Buffer.from(JSON.stringify(event({ data: { object: { object: "customer" } } })))]) {
      const error = rejection(() => verify(headers(raw, c.secrets[0].value), raw), "INVALID_ENVELOPE");
      expect(String(error) + JSON.stringify(error)).not.toContain(marker);
      expect(String(error) + JSON.stringify(error)).not.toContain(c.secrets[0].value);
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 whether the signature covers original bytes or SDK replacement-decoded text", () => {
    const c = config(), verify = createStripeTestSnapshotVerifier(c);
    const raw = Buffer.concat([Buffer.from(JSON.stringify(event()).slice(0, -1) + ',"unknown":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
    rejection(() => verify(headers(raw, c.secrets[0].value), raw), "SIGNATURE_INVALID");
    const replacementEncoded = Buffer.from(new TextDecoder().decode(raw));
    rejection(() => verify(headers(replacementEncoded, c.secrets[0].value), raw), "INVALID_ENVELOPE");
  });

  it("rejects an added UTF-8 byte-order mark that the SDK decoder would otherwise hide", () => {
    const c = config(), verify = createStripeTestSnapshotVerifier(c), raw = Buffer.from(JSON.stringify(event()));
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]);
    rejection(() => verify(headers(raw, c.secrets[0].value), withBom), "INVALID_ENVELOPE");
  });

  it("rejects live-mode and Connect scope and supports only the two selected snapshot event types", () => {
    const c = config(), verify = createStripeTestSnapshotVerifier(c);
    for (const body of [event({ livemode: true }), event({ account: "acct_private" }), event({ context: "acct_private" })]) {
      const raw = Buffer.from(JSON.stringify(body)); rejection(() => verify(headers(raw, c.secrets[0].value), raw), "UNSUPPORTED_SCOPE");
    }
    const unsupported = Buffer.from(JSON.stringify(event({ type: "payment_intent.updated" })));
    rejection(() => verify(headers(unsupported, c.secrets[0].value), unsupported), "UNSUPPORTED_EVENT");
    const thin = Buffer.from(JSON.stringify(event({ object: "v2.core.event" })));
    rejection(() => verify(headers(thin, c.secrets[0].value), thin), "INVALID_ENVELOPE");
    const success = Buffer.from(JSON.stringify(event({ type: "payment_intent.succeeded", api_version: null, account: null })));
    expect(readVerifiedStripeSnapshotMetadata(verify(headers(success, c.secrets[0].value), success))).toMatchObject({ eventType: "payment_intent.succeeded", reportedApiVersion: null });
  });

  it("accepts exactly 128 KiB and refuses empty or oversized bodies without modifying them", () => {
    const c = config(), verify = createStripeTestSnapshotVerifier(c);
    const template = event({ padding: "" });
    const paddingLength = 131_072 - Buffer.byteLength(JSON.stringify(template));
    const atLimit = Buffer.from(JSON.stringify({ ...template, padding: "x".repeat(paddingLength) }));
    expect(atLimit.length).toBe(131_072);
    expect(readVerifiedStripeSnapshotMetadata(verify(headers(atLimit, c.secrets[0].value), atLimit)).eventId).toBe(template.id);
    for (const raw of [Buffer.alloc(0), Buffer.alloc(STRIPE_SNAPSHOT_LIMITS.bodyBytes + 1, 65)]) {
      rejection(() => verify(headers(raw, c.secrets[0].value), raw), "INVALID_BODY");
      if (raw.length) expect(raw[0]).toBe(65);
    }
  });

  it("returns fixed diagnostics for an invalid signature even when the body contains secrets", () => {
    const c = config(), verify = createStripeTestSnapshotVerifier(c), marker = `unique-private-${randomUUID()}`;
    const raw = Buffer.from(JSON.stringify(event({ data: { object: { object: "payment_intent", client_secret: marker } } })));
    const error = rejection(() => verify(headers(raw, config().secrets[0].value), raw), "SIGNATURE_INVALID");
    expect(String(error) + JSON.stringify(error)).not.toContain(marker);
    expect(Object.getOwnPropertyNames(error)).not.toContain("cause");
  });

  it("rejects invalid local configuration without printing configured secrets", () => {
    const c = config();
    for (const invalid of [{ ...c, workspaceId: "bad" }, { ...c, secrets: [] }, { ...c, secrets: [c.secrets[0], c.secrets[0]] },
      { ...c, secrets: [c.secrets[0], { ...config().secrets[0], id: c.secrets[0].id }] },
      { ...c, secrets: [c.secrets[0], { ...config().secrets[0], value: c.secrets[0].value }] },
      { ...c, secrets: [c.secrets[0], config().secrets[0], config().secrets[0]] },
      { ...c, secrets: [{ ...c.secrets[0], value: "sk_test_not_a_webhook_secret" }] },
      { ...c, secrets: [{ ...c.secrets[0], expiresAt: "bad" }] }]) {
      // Runtime validation also applies to untyped configuration files.
      const result = rejection(() => createStripeTestSnapshotVerifier(invalid), "INVALID_CONFIGURATION");
      expect(JSON.stringify(result)).not.toContain(c.secrets[0].value);
    }
  });
});


describe("Stripe protected proof lifetime", () => {
  it("rejects a forged proof and rechecks signature freshness and key expiry before acceptance", () => {
    const c = config(), raw = Buffer.from(JSON.stringify(event()));
    const verify = createStripeTestSnapshotVerifier(c);
    const proof = verify(headers(raw, c.secrets[0].value), raw);
    expect(readProtectedStripeSnapshot(proof).shape.allValuesOmitted).toBe(true);
    rejection(() => readProtectedStripeSnapshot({}), "UNKNOWN_PROOF");
    vi.advanceTimersByTime(301_000);
    rejection(() => readProtectedStripeSnapshot(proof), "TIMESTAMP_OUT_OF_RANGE");
    const next = config(); next.secrets[0].expiresAt = new Date(Date.now() + 1_000).toISOString();
    const nextProof = createStripeTestSnapshotVerifier(next)(headers(raw, next.secrets[0].value), raw);
    vi.advanceTimersByTime(1_000);
    rejection(() => readProtectedStripeSnapshot(nextProof), "SIGNING_KEY_UNAVAILABLE");
  });
});
