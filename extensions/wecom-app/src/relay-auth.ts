/**
 * Client side of the wecom-app-relay per-account auth (scheme "hmac-sha256-v1").
 * Keep in sync with wecom-app-relay/src/auth.ts.
 */

import crypto from "node:crypto";

export const RELAY_AUTH_SCHEME = "hmac-sha256-v1";
const CANONICAL_PREFIX = "wecom-relay-auth-v1";

export type RelayAuthSignatureFields = {
  auth_scheme: typeof RELAY_AUTH_SCHEME;
  auth_ts: number;
  auth_nonce: string;
  auth_sig: string;
};

export function computeRelayAuthSignature(
  secret: string,
  input: { userId: string; corpId: string; agentId: string; ts: number; nonce: string },
): string {
  const canonical = [CANONICAL_PREFIX, input.userId, input.corpId, input.agentId, String(input.ts), input.nonce].join("\n");
  return crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

/** Build fresh signature fields (new nonce + current timestamp) for one auth attempt. */
export function buildRelayAuthSignatureFields(
  secret: string,
  input: { userId: string; corpId: string; agentId: string },
  now: () => number = Date.now,
): RelayAuthSignatureFields {
  const ts = Math.floor(now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  return {
    auth_scheme: RELAY_AUTH_SCHEME,
    auth_ts: ts,
    auth_nonce: nonce,
    auth_sig: computeRelayAuthSignature(secret, { ...input, ts, nonce }),
  };
}
