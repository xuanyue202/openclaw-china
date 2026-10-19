/**
 * Per-account relay authentication (hmac-sha256-v1) tests.
 *
 * Covers: signature unit tests, replay/skew, per-account isolation, compat vs strict
 * migration modes, global authToken scoping on WS and /send.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocket } from "ws";

import { createRelayServer } from "./server.js";
import { computeAuthSignature, verifyAuthSignature, NonceCache, buildAuthCanonical } from "./auth.js";
import type { RelayConfig, AccountConfig } from "./config.js";
import { loadConfig } from "./config.js";

vi.mock("./wecom-api.js", () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ ok: true, errcode: 0, errmsg: "ok" }),
}));
import { sendTextMessage } from "./wecom-api.js";
const mockSendText = vi.mocked(sendTextMessage);

// Test-only fixture values (not real credentials)
const CORP = "ww_test_corp";
const AUTH_TOKEN = "test-global-relay-token-not-real";
const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);

function account(agentId: number, path: string, clientSecret?: string): AccountConfig {
  return {
    token: "cb_token",
    encodingAESKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    receiveId: CORP,
    corpId: CORP,
    corpSecret: "corp_secret_fixture",
    agentId,
    apiBaseUrl: "https://qyapi.weixin.qq.com",
    webhookPath: path,
    ...(clientSecret ? { clientSecret } : {}),
  };
}

function buildConfig(overrides?: Partial<RelayConfig>): RelayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH_TOKEN,
    accounts: {
      a: account(1000011, "/wecom-a", SECRET_A),
      b: account(1000012, "/wecom-b", SECRET_B),
      legacy: account(1000013, "/wecom-legacy"),
    },
    ...overrides,
  };
}

function port(r: ReturnType<typeof createRelayServer>): number {
  const addr = r.server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

function connect(p: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function recv(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("recv timeout")), timeoutMs);
    ws.once("message", (d: Buffer | string) => {
      clearTimeout(t);
      resolve(JSON.parse(typeof d === "string" ? d : d.toString("utf8")));
    });
  });
}

function signedAuth(opts: {
  agentId: number;
  secret?: string;
  userId?: string;
  ts?: number;
  nonce?: string;
  sig?: string;
}) {
  const userId = opts.userId ?? "u1";
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? crypto.randomBytes(16).toString("hex");
  const base = {
    type: "auth",
    user_id: userId,
    platform: "wecom",
    wecom_corp_id: CORP,
    wecom_agent_id: String(opts.agentId),
  };
  if (!opts.secret && !opts.sig) return base;
  const sig = opts.sig ?? computeAuthSignature(opts.secret!, {
    userId, corpId: CORP, agentId: String(opts.agentId), ts, nonce,
  });
  return { ...base, auth_scheme: "hmac-sha256-v1", auth_ts: ts, auth_nonce: nonce, auth_sig: sig };
}

async function auth(p: number, msg: Record<string, unknown>, keep: WebSocket[]) {
  const ws = await connect(p);
  keep.push(ws);
  ws.send(JSON.stringify(msg));
  return { ws, result: await recv(ws) };
}

function httpReq(p: number, opts: { method: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: p, method: opts.method, path: opts.path, headers: opts.headers }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("auth.ts primitives", () => {
  const input = { userId: "u", corpId: CORP, agentId: "1", ts: 1_700_000_000, nonce: "n".repeat(16) };

  it("canonical string is stable", () => {
    expect(buildAuthCanonical(input)).toBe(`wecom-relay-auth-v1\nu\n${CORP}\n1\n1700000000\n${"n".repeat(16)}`);
  });

  it("verifies a correct signature once, then rejects replay", () => {
    const cache = new NonceCache();
    const sig = computeAuthSignature(SECRET_A, input);
    const now = input.ts * 1000;
    expect(verifyAuthSignature({ secret: SECRET_A, accountId: "a", input, signature: sig, maxSkewSec: 300, nonceCache: cache, nowMs: now })).toEqual({ ok: true });
    expect(verifyAuthSignature({ secret: SECRET_A, accountId: "a", input, signature: sig, maxSkewSec: 300, nonceCache: cache, nowMs: now })).toEqual({ ok: false, reason: "replayed auth_nonce" });
  });

  it("rejects wrong secret, skew, bad nonce, bad sig format", () => {
    const cache = new NonceCache();
    const now = input.ts * 1000;
    const good = computeAuthSignature(SECRET_A, input);
    const v = (o: Partial<Parameters<typeof verifyAuthSignature>[0]>) =>
      verifyAuthSignature({ secret: SECRET_A, accountId: "a", input, signature: good, maxSkewSec: 300, nonceCache: cache, nowMs: now, ...o });
    expect(v({ signature: computeAuthSignature(SECRET_B, input) })).toEqual({ ok: false, reason: "signature mismatch" });
    expect(v({ nowMs: now + 301_000 })).toEqual({ ok: false, reason: "auth_ts outside allowed clock skew" });
    expect(v({ input: { ...input, nonce: "short" } })).toEqual({ ok: false, reason: "invalid auth_nonce" });
    expect(v({ signature: "zz" })).toEqual({ ok: false, reason: "invalid auth_sig format" });
    expect(v({ input: { ...input, ts: "abc" } })).toEqual({ ok: false, reason: "invalid auth_ts" });
  });

  it("failed verifications do not consume the nonce", () => {
    const cache = new NonceCache();
    const now = input.ts * 1000;
    verifyAuthSignature({ secret: SECRET_A, accountId: "a", input, signature: computeAuthSignature(SECRET_B, input), maxSkewSec: 300, nonceCache: cache, nowMs: now });
    expect(cache.size).toBe(0);
  });
});

describe("config schema", () => {
  it("rejects a too-short clientSecret", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const f = path.join(os.tmpdir(), `relay-cfg-${process.pid}.json`);
    fs.writeFileSync(f, JSON.stringify({ authToken: "x", accounts: { a: { ...account(1, "/a"), clientSecret: "short" } } }));
    expect(() => loadConfig(f)).toThrow(/clientSecret/);
    fs.writeFileSync(f, JSON.stringify({ authToken: "x", authMode: "strict", accounts: { a: { ...account(1, "/a"), clientSecret: SECRET_A } } }));
    expect(loadConfig(f).authMode).toBe("strict");
    fs.unlinkSync(f);
  });
});

describe("relay per-account auth", () => {
  let relay: ReturnType<typeof createRelayServer> | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    sockets.length = 0;
    if (relay) { await relay.stop(); relay = null; }
    mockSendText.mockClear();
  });

  async function start(overrides?: Partial<RelayConfig>) {
    relay = createRelayServer(buildConfig(overrides));
    await relay.start();
    return port(relay);
  }

  it("correct per-account signature → success, scoped to that account only", async () => {
    const p = await start();
    const { result } = await auth(p, signedAuth({ agentId: 1000011, secret: SECRET_A }), sockets);
    expect(result.success).toBe(true);
    expect(result.auth_version).toBe("hmac-sha256-v1");
    expect(result.warnings).toBeUndefined();
    expect([...relay!.accountToClient.keys()]).toEqual(["a"]);
  });

  it("wrong secret is rejected (compat mode too) and does not fall back to global token", async () => {
    const p = await start();
    const msg = { ...signedAuth({ agentId: 1000011, secret: SECRET_B }), token: AUTH_TOKEN };
    const { result } = await auth(p, msg, sockets);
    expect(result).toMatchObject({ success: false, error: "invalid credentials" });
    expect(relay!.accountToClient.size).toBe(0);
  });

  it("account A's secret cannot log into account B", async () => {
    const p = await start();
    const { result } = await auth(p, signedAuth({ agentId: 1000012, secret: SECRET_A }), sockets);
    expect(result.success).toBe(false);
  });

  it("replayed auth message is rejected", async () => {
    const p = await start();
    const msg = signedAuth({ agentId: 1000011, secret: SECRET_A });
    expect((await auth(p, msg, sockets)).result.success).toBe(true);
    expect((await auth(p, msg, sockets)).result.success).toBe(false);
  });

  it("stale timestamp is rejected", async () => {
    const p = await start({ authMaxSkewSec: 60 });
    const { result } = await auth(p, signedAuth({ agentId: 1000011, secret: SECRET_A, ts: Math.floor(Date.now() / 1000) - 120 }), sockets);
    expect(result.success).toBe(false);
  });

  it("signature bound to user_id: tampering user_id fails", async () => {
    const p = await start();
    const msg = { ...signedAuth({ agentId: 1000011, secret: SECRET_A, userId: "u1" }), user_id: "attacker" };
    expect((await auth(p, msg, sockets)).result.success).toBe(false);
  });

  it("compat: unsigned client of a secret-protected account is accepted with a warning", async () => {
    const p = await start();
    const { result } = await auth(p, signedAuth({ agentId: 1000011 }), sockets);
    expect(result.success).toBe(true);
    expect(result.auth_version).toBe("legacy");
    expect(String((result.warnings as string[])[0])).toMatch(/unsigned auth accepted in compat mode/);
  });

  it("compat: account without clientSecret still accepts corpId+agentId with a warning", async () => {
    const p = await start();
    const { result } = await auth(p, signedAuth({ agentId: 1000013 }), sockets);
    expect(result.success).toBe(true);
    expect(String((result.warnings as string[])[0])).toMatch(/no clientSecret configured/);
  });

  it("strict: unsigned client is rejected", async () => {
    const p = await start({ authMode: "strict" });
    expect((await auth(p, signedAuth({ agentId: 1000011 }), sockets)).result.success).toBe(false);
  });

  it("strict: account without clientSecret cannot be logged into by corpId+agentId", async () => {
    const p = await start({ authMode: "strict" });
    expect((await auth(p, signedAuth({ agentId: 1000013 }), sockets)).result.success).toBe(false);
  });

  it("strict: signed client succeeds", async () => {
    const p = await start({ authMode: "strict" });
    expect((await auth(p, signedAuth({ agentId: 1000012, secret: SECRET_B }), sockets)).result.success).toBe(true);
  });

  it("an unsigned attacker cannot displace a signed client in strict mode", async () => {
    const p = await start({ authMode: "strict" });
    const good = await auth(p, signedAuth({ agentId: 1000011, secret: SECRET_A }), sockets);
    const goodSession = good.result.session_id as string;
    const bad = await auth(p, signedAuth({ agentId: 1000011 }), sockets);
    expect(bad.result.success).toBe(false);
    expect(relay!.accountToClient.get("a")).toBe(goodSession);
    expect(good.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("global token WS login works by default (with warning) and can be disabled", async () => {
    let p = await start();
    let r = (await auth(p, { type: "auth", user_id: "ops", token: AUTH_TOKEN }, sockets)).result;
    expect(r.success).toBe(true);
    expect(r.auth_version).toBe("global-token");
    await relay!.stop(); relay = null;
    p = await start({ allowGlobalTokenWs: false });
    r = (await auth(p, { type: "auth", user_id: "ops", token: AUTH_TOKEN }, sockets)).result;
    expect(r.success).toBe(false);
  });

  describe("POST /send scoping", () => {
    const send = (p: number, bearer: string, accountId: string) => httpReq(p, {
      method: "POST",
      path: "/send",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, userId: "Chen", text: "hi" }),
    });

    it("per-account secret can send for its own account only", async () => {
      const p = await start();
      expect((await send(p, SECRET_A, "a")).status).toBe(200);
      expect(mockSendText).toHaveBeenCalledTimes(1);
      expect((await send(p, SECRET_A, "b")).status).toBe(401);
      expect((await send(p, SECRET_A, "legacy")).status).toBe(401);
      expect((await send(p, SECRET_A, "nope")).status).toBe(401);
      expect(mockSendText).toHaveBeenCalledTimes(1);
    });

    it("global token works by default and can be disabled", async () => {
      let p = await start();
      expect((await send(p, AUTH_TOKEN, "b")).status).toBe(200);
      await relay!.stop(); relay = null;
      p = await start({ allowGlobalTokenSend: false });
      expect((await send(p, AUTH_TOKEN, "b")).status).toBe(401);
      expect((await send(p, SECRET_B, "b")).status).toBe(200);
    });
  });
});
