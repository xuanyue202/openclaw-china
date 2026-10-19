import { describe, it, expect } from "vitest";
import { buildRelayAuthSignatureFields, computeRelayAuthSignature } from "./relay-auth.js";
import { computeAuthSignature, verifyAuthSignature, NonceCache } from "../../../wecom-app-relay/src/auth.js";

const SECRET = "s".repeat(40);

describe("relay-auth (client)", () => {
  it("matches the relay server's signature algorithm", () => {
    const input = { userId: "u", corpId: "ww", agentId: "1000002", ts: 1_700_000_000, nonce: "0123456789abcdef" };
    expect(computeRelayAuthSignature(SECRET, input)).toBe(computeAuthSignature(SECRET, input));
  });

  it("builds fresh fields that the server accepts", () => {
    const now = 1_700_000_000_000;
    const f = buildRelayAuthSignatureFields(SECRET, { userId: "u", corpId: "ww", agentId: "1" }, () => now);
    expect(f.auth_scheme).toBe("hmac-sha256-v1");
    expect(f.auth_ts).toBe(1_700_000_000);
    expect(f.auth_nonce).toMatch(/^[0-9a-f]{32}$/);
    const r = verifyAuthSignature({
      secret: SECRET, accountId: "a",
      input: { userId: "u", corpId: "ww", agentId: "1", ts: f.auth_ts, nonce: f.auth_nonce },
      signature: f.auth_sig, maxSkewSec: 300, nonceCache: new NonceCache(), nowMs: now,
    });
    expect(r).toEqual({ ok: true });
  });

  it("uses a new nonce every call", () => {
    const a = buildRelayAuthSignatureFields(SECRET, { userId: "u", corpId: "ww", agentId: "1" });
    const b = buildRelayAuthSignatureFields(SECRET, { userId: "u", corpId: "ww", agentId: "1" });
    expect(a.auth_nonce).not.toBe(b.auth_nonce);
  });
});
