/**
 * Per-account client authentication (HMAC-SHA256, scheme "hmac-sha256-v1").
 *
 * The client proves knowledge of the account's `clientSecret` without sending it:
 *
 *   auth_sig = hex(HMAC_SHA256(clientSecret, canonical))
 *   canonical = "wecom-relay-auth-v1\n" + user_id + "\n" + wecom_corp_id + "\n"
 *             + wecom_agent_id + "\n" + auth_ts + "\n" + auth_nonce
 *
 * - auth_ts: unix seconds; must be within ±maxSkewSec of server time.
 * - auth_nonce: 16–128 chars of [A-Za-z0-9_-]; each (account, nonce) is accepted once
 *   within the skew window (replay protection).
 *
 * Keep this file in sync with extensions/wecom-app/src/relay-auth.ts.
 */

import crypto from "node:crypto";

export const AUTH_SCHEME = "hmac-sha256-v1";
export const AUTH_CANONICAL_PREFIX = "wecom-relay-auth-v1";
export const DEFAULT_AUTH_MAX_SKEW_SEC = 300;
export const MIN_CLIENT_SECRET_LENGTH = 32;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export type AuthSignatureInput = {
  userId: string;
  corpId: string;
  agentId: string;
  ts: number | string;
  nonce: string;
};

export function buildAuthCanonical(input: AuthSignatureInput): string {
  return [AUTH_CANONICAL_PREFIX, input.userId, input.corpId, input.agentId, String(input.ts), input.nonce].join("\n");
}

export function computeAuthSignature(secret: string, input: AuthSignatureInput): string {
  return crypto.createHmac("sha256", secret).update(buildAuthCanonical(input), "utf8").digest("hex");
}

/** Constant-time compare of two hex/utf8 strings (false on length mismatch). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Replay cache: remembers (accountId, nonce) until the signature would expire anyway.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>(); // key → expiresAt (ms)
  constructor(private readonly maxEntries = 10_000) {}

  /** Returns false if the nonce was already used (replay). */
  checkAndRemember(key: string, expiresAt: number, now = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.maxEntries) {
      // drop the oldest entry (Map preserves insertion order)
      const first = this.seen.keys().next();
      if (!first.done) this.seen.delete(first.value);
    }
    this.seen.set(key, expiresAt);
    return true;
  }

  private prune(now: number): void {
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

export function verifyAuthSignature(params: {
  secret: string;
  accountId: string;
  input: AuthSignatureInput;
  signature: string;
  maxSkewSec: number;
  nonceCache: NonceCache;
  nowMs?: number;
}): VerifyResult {
  const { secret, accountId, input, signature, maxSkewSec, nonceCache } = params;
  const nowMs = params.nowMs ?? Date.now();

  const tsNum = typeof input.ts === "number" ? input.ts : Number(input.ts);
  if (!Number.isFinite(tsNum) || !Number.isInteger(tsNum)) return { ok: false, reason: "invalid auth_ts" };
  if (Math.abs(nowMs / 1000 - tsNum) > maxSkewSec) return { ok: false, reason: "auth_ts outside allowed clock skew" };
  if (!NONCE_RE.test(input.nonce)) return { ok: false, reason: "invalid auth_nonce" };
  if (!/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, reason: "invalid auth_sig format" };

  const expected = computeAuthSignature(secret, { ...input, ts: tsNum });
  if (!timingSafeEqualStr(expected, signature.toLowerCase())) return { ok: false, reason: "signature mismatch" };

  // Only remember the nonce after the signature is valid, so garbage can't fill the cache.
  const expiresAt = (tsNum + maxSkewSec) * 1000;
  if (!nonceCache.checkAndRemember(`${accountId}:${input.nonce}`, expiresAt, nowMs)) {
    return { ok: false, reason: "replayed auth_nonce" };
  }
  return { ok: true };
}
