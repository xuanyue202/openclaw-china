/**
 * End-to-end: real wecom-app-relay server (../../../wecom-app-relay) + real ws-relay-client.
 *
 * Flow per case:
 *   simulated WeCom callback (encrypted POST /wecom-x) → relay → WS wecom_raw → client decrypts
 *   → dispatch (stubbed agent: echoes text) → client POST /webhook → relay → sendTextMessage(account)
 *   and active send: sendViaWsRelay → WS send_message → relay → sendTextMessage(account)
 *
 * Only the outermost edges are stubbed: the relay's WeCom HTTP API (qyapi) and the OpenClaw agent.
 * All values below are test fixtures, not real credentials.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import crypto from "node:crypto";

vi.mock("../../../wecom-app-relay/src/wecom-api.js", () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ ok: true, errcode: 0, errmsg: "ok" }),
}));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  tryGetWecomAppRuntime: () => ({}),
}));
vi.mock("./bot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot.js")>()),
  dispatchWecomAppMessage: vi.fn(async (params: { msg: { Content?: string; content?: string }; hooks: { onChunk: (t: string) => void } }) => {
    params.hooks.onChunk(`echo: ${params.msg.Content ?? params.msg.content ?? ""}`);
  }),
}));

import { createRelayServer } from "../../../wecom-app-relay/src/server.js";
import { encrypt, computeMsgSignature } from "../../../wecom-app-relay/src/wecom-crypto.js";
import { sendTextMessage } from "../../../wecom-app-relay/src/wecom-api.js";
import type { RelayConfig, AccountConfig } from "../../../wecom-app-relay/src/config.js";
import { resolveWecomAppAccount, type PluginConfig } from "./config.js";
import { startWecomAppWsRelayClient, sendViaWsRelay } from "./ws-relay-client.js";
import { sendWecomAppMessage } from "./api.js";
import { wecomAppPlugin } from "./channel.js";

const mockSendText = vi.mocked(sendTextMessage);

const CORP = "ww_e2e_corp";
const AES = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CB_TOKEN = "e2e_callback_token";
const GLOBAL = "e2e-global-token-fixture";
const SECRET_A = crypto.randomBytes(24).toString("hex"); // 48 chars
const SECRET_B = crypto.randomBytes(24).toString("hex");
const AGENT_A = 2000001;
const AGENT_B = 2000002;
const AGENT_LEGACY = 2000003;

function relayAccount(agentId: number, path: string, clientSecret?: string): AccountConfig {
  return {
    token: CB_TOKEN, encodingAESKey: AES, receiveId: CORP, corpId: CORP,
    corpSecret: "corp_secret_fixture", agentId, apiBaseUrl: "https://qyapi.invalid",
    webhookPath: path, ...(clientSecret ? { clientSecret } : {}),
  };
}

function relayConfig(overrides?: Partial<RelayConfig>): RelayConfig {
  return {
    host: "127.0.0.1", port: 0, authToken: GLOBAL,
    accounts: {
      a: relayAccount(AGENT_A, "/wecom-a", SECRET_A),
      b: relayAccount(AGENT_B, "/wecom-b", SECRET_B),
      legacy: relayAccount(AGENT_LEGACY, "/wecom-legacy"),
    },
    ...overrides,
  };
}

async function waitUntil(fn: () => boolean, ms: number, label: string) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function postCallback(port: number, path: string, fromUser: string, text: string, msgId: string, agentId: number) {
  const xml = `<xml><ToUserName><![CDATA[${CORP}]]></ToUserName><FromUserName><![CDATA[${fromUser}]]></FromUserName>`
    + `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType>`
    + `<Content><![CDATA[${text}]]></Content><MsgId>${msgId}</MsgId><AgentID>${agentId}</AgentID></xml>`;
  const enc = encrypt(AES, CORP, xml);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(6).toString("hex");
  const sig = computeMsgSignature(CB_TOKEN, ts, nonce, enc);
  const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
  return new Promise<number>((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, method: "POST",
      path: `${path}?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`,
      headers: { "Content-Type": "text/xml" },
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject);
    req.end(body);
  });
}

type Started = {
  logs: string[];
  statuses: Record<string, unknown>[];
  abort: AbortController;
  done: Promise<void>;
};

function clientCfg(port: number, opts: { agentId: number; secret?: string; userId: string }): PluginConfig {
  return {
    channels: {
      "wecom-app": {
        mode: "ws-relay",
        token: CB_TOKEN, encodingAESKey: AES, receiveId: CORP, corpId: CORP,
        corpSecret: "corp_secret_fixture", agentId: opts.agentId, dmPolicy: "open",
        wsRelayUrl: `ws://127.0.0.1:${port}/ws`,
        wsRelayWebhookUrl: `http://127.0.0.1:${port}/webhook`,
        wsRelayUserId: opts.userId,
        wsRelayReconnectMs: 60_000, // don't reconnect during a test
        ...(opts.secret ? { wsRelaySecret: opts.secret } : {}),
      },
    },
  } as PluginConfig;
}

function startClient(port: number, opts: { agentId: number; secret?: string; userId: string }): Started {
  const cfg = clientCfg(port, opts);
  const account = resolveWecomAppAccount({ cfg });
  const logs: string[] = [];
  const statuses: Record<string, unknown>[] = [];
  const abort = new AbortController();
  const done = startWecomAppWsRelayClient({
    cfg, account,
    runtime: { log: (m: string) => logs.push(m), error: (m: string) => logs.push(`ERROR: ${m}`) },
    abortSignal: abort.signal,
    setStatus: (s) => statuses.push({ ...s }),
  });
  return { logs, statuses, abort, done };
}

const connected = (c: Started) => c.statuses.some((s) => s.connectionState === "connected");
const authFailed = (c: Started) => c.statuses.some((s) => s.connectionState === "auth_failed");

describe("e2e: relay per-account auth + ws-relay-client", () => {
  let relay: ReturnType<typeof createRelayServer> | null = null;
  const clients: Started[] = [];

  afterEach(async () => {
    for (const c of clients) c.abort.abort();
    await Promise.all(clients.map((c) => Promise.race([c.done, new Promise((r) => setTimeout(r, 1500))])));
    clients.length = 0;
    if (relay) { await relay.stop(); relay = null; }
    mockSendText.mockClear();
  });

  async function startRelay(overrides?: Partial<RelayConfig>) {
    relay = createRelayServer(relayConfig(overrides));
    await relay.start();
    const addr = relay.server.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  async function roundTrip(port: number, path: string, agentId: number, tag: string) {
    const status = await postCallback(port, path, "Chen", `你好-${tag}`, `msg-${tag}-${Date.now()}`, agentId);
    expect(status).toBe(200);
    await waitUntil(() => mockSendText.mock.calls.some((c) => c[2] === `echo: 你好-${tag}`), 5000, `inbound echo ${tag}`);
    const inboundCall = mockSendText.mock.calls.find((c) => c[2] === `echo: 你好-${tag}`)!;
    expect(inboundCall[0].agentId).toBe(agentId);
    expect(inboundCall[1]).toBe("Chen");

    const out = await sendViaWsRelay({ channelId: "Chen", text: `主动-${tag}` });
    expect(out).toMatchObject({ ok: true });
    const outCall = mockSendText.mock.calls.find((c) => c[2] === `主动-${tag}`)!;
    expect(outCall[0].agentId).toBe(agentId);
  }

  it("correct per-account secret: connects (hmac) and full inbound→reply + send_message round trip works", async () => {
    const port = await startRelay();
    const c = startClient(port, { agentId: AGENT_A, secret: SECRET_A, userId: "box-a" });
    clients.push(c);
    await waitUntil(() => connected(c), 5000, "connected");
    expect(c.logs.some((l) => l.includes("auth=hmac-sha256-v1"))).toBe(true);
    expect(c.logs.some((l) => l.includes("relay auth warning"))).toBe(false);
    expect([...relay!.accountToClient.keys()]).toEqual(["a"]);
    await roundTrip(port, "/wecom-a", AGENT_A, "a");
  }, 15000);

  it("strict mode: correct secret still works end-to-end", async () => {
    const port = await startRelay({ authMode: "strict", allowGlobalTokenWs: false, allowGlobalTokenSend: false });
    const c = startClient(port, { agentId: AGENT_B, secret: SECRET_B, userId: "box-b" });
    clients.push(c);
    await waitUntil(() => connected(c), 5000, "connected");
    await roundTrip(port, "/wecom-b", AGENT_B, "b-strict");
  }, 15000);

  it("wrong secret is rejected (compat mode)", async () => {
    const port = await startRelay();
    const c = startClient(port, { agentId: AGENT_A, secret: "x".repeat(48), userId: "wrong" });
    clients.push(c);
    await waitUntil(() => authFailed(c), 5000, "auth_failed");
    expect(connected(c)).toBe(false);
    expect(relay!.accountToClient.size).toBe(0);
  }, 10000);

  it("missing secret is rejected in strict mode", async () => {
    const port = await startRelay({ authMode: "strict" });
    const c = startClient(port, { agentId: AGENT_A, userId: "nosecret" });
    clients.push(c);
    await waitUntil(() => authFailed(c), 5000, "auth_failed");
    expect(relay!.accountToClient.size).toBe(0);
  }, 10000);

  it("account A's secret cannot connect to account B", async () => {
    const port = await startRelay();
    const c = startClient(port, { agentId: AGENT_B, secret: SECRET_A, userId: "cross" });
    clients.push(c);
    await waitUntil(() => authFailed(c), 5000, "auth_failed");
    expect(relay!.accountToClient.has("b")).toBe(false);
    // and inbound for B is buffered, not delivered to anyone
    expect(await postCallback(port, "/wecom-b", "FeiFei", "x", "m-cross", AGENT_B)).toBe(200);
    expect(relay!.offlineBuffer.get("b")?.length).toBe(1);
  }, 10000);

  it("transition: legacy client (no secret) still works in compat mode, with warnings", async () => {
    const port = await startRelay();
    const c = startClient(port, { agentId: AGENT_A, userId: "legacy-a" });
    clients.push(c);
    await waitUntil(() => connected(c), 5000, "connected");
    expect(c.logs.some((l) => l.includes("auth=legacy"))).toBe(true);
    expect(c.logs.some((l) => l.includes("relay auth warning") && l.includes("unsigned auth accepted"))).toBe(true);
    expect(c.logs.some((l) => l.includes("wsRelaySecret not configured"))).toBe(true);
    await roundTrip(port, "/wecom-a", AGENT_A, "legacy");
  }, 15000);

  it("transition: legacy client against an account with no clientSecret works in compat, rejected in strict", async () => {
    let port = await startRelay();
    let c = startClient(port, { agentId: AGENT_LEGACY, userId: "old" });
    clients.push(c);
    await waitUntil(() => connected(c), 5000, "connected");
    await roundTrip(port, "/wecom-legacy", AGENT_LEGACY, "legacy-acct");
    c.abort.abort();
    await relay!.stop(); relay = null;

    port = await startRelay({ authMode: "strict" });
    c = startClient(port, { agentId: AGENT_LEGACY, userId: "old2" });
    clients.push(c);
    await waitUntil(() => authFailed(c), 5000, "auth_failed");
  }, 20000);

  it("strict mode: unsigned client cannot displace a signed one", async () => {
    const port = await startRelay({ authMode: "strict" });
    const good = startClient(port, { agentId: AGENT_A, secret: SECRET_A, userId: "good" });
    clients.push(good);
    await waitUntil(() => connected(good), 5000, "good connected");
    const sessionBefore = relay!.accountToClient.get("a");
    const bad = startClient(port, { agentId: AGENT_A, userId: "attacker" });
    clients.push(bad);
    await waitUntil(() => authFailed(bad), 5000, "bad rejected");
    expect(relay!.accountToClient.get("a")).toBe(sessionBefore);
    expect(good.statuses.some((s) => s.connectionState === "disconnected")).toBe(false);
  }, 15000);

  it("signed client does not send WeCom app secrets to the relay", async () => {
    const port = await startRelay();
    const seen: string[] = [];
    relay!.wss.on("connection", (ws) => ws.on("message", (d: Buffer) => seen.push(d.toString("utf8"))));
    const c = startClient(port, { agentId: AGENT_A, secret: SECRET_A, userId: "box-a2" });
    clients.push(c);
    await waitUntil(() => connected(c), 5000, "connected");
    const authMsg = JSON.parse(seen.find((s) => s.includes('"type":"auth"'))!);
    expect(authMsg.auth_sig).toMatch(/^[0-9a-f]{64}$/);
    expect(authMsg.wecom_secret).toBeUndefined();
    expect(authMsg.wecom_token).toBeUndefined();
    expect(authMsg.wecom_aes_key).toBeUndefined();
    expect(JSON.stringify(authMsg)).not.toContain(SECRET_A);
  }, 10000);
});

describe("e2e: PATCH12 relay send semantics (real relay + real client)", () => {
  let relay: ReturnType<typeof createRelayServer> | null = null;
  const clients: Started[] = [];

  afterEach(async () => {
    for (const c of clients) c.abort.abort();
    await Promise.all(clients.map((c) => Promise.race([c.done, new Promise((r) => setTimeout(r, 1500))])));
    clients.length = 0;
    if (relay) { await relay.stop(); relay = null; }
    mockSendText.mockClear();
  });

  async function boot() {
    mockSendText.mockReset();
    mockSendText.mockResolvedValue({ ok: true, errcode: 0, errmsg: "ok" });
    relay = createRelayServer(relayConfig({ authMode: "strict" }));
    await relay.start();
    const addr = relay.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const opts = { agentId: AGENT_A, secret: SECRET_A, userId: "p12" };
    const c = startClient(port, opts);
    clients.push(c);
    await waitUntil(() => connected(c), 5000, "connected");
    return { port, cfg: clientCfg(port, opts) };
  }

  it("success: send_message returns correlated transportAck (not a platform msgid)", async () => {
    await boot();
    const r = await sendViaWsRelay({ channelId: "Chen", text: "p12-ok" });
    expect(r?.ok).toBe(true);
    expect(r?.transportAck).toMatchObject({ kind: "wecom-relay-send-result", accepted: true });
    expect(r?.transportAck?.requestId).toMatch(/^send_/);
    expect(r?.msgid).toBeUndefined();
  }, 15000);

  it("relay-side failure is final: sendWecomAppMessage returns ok:false and does NOT fall back to direct HTTP", async () => {
    const { cfg } = await boot();
    mockSendText.mockResolvedValueOnce({ ok: false, errcode: 81013, errmsg: "user invalid" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const account = resolveWecomAppAccount({ cfg });
    const r = await sendWecomAppMessage(account, { userId: "Chen" }, "p12-fail");
    expect(r).toMatchObject({ ok: false, errcode: 81013, errmsg: "user invalid" });
    expect(r.transportAck).toBeUndefined();
    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("qyapi"))).toHaveLength(0);
    fetchSpy.mockRestore();
  }, 15000);

  it("outbound.sendText: success carries transportAck; provider failure throws (not ok:false)", async () => {
    const { cfg } = await boot();
    const ok = await wecomAppPlugin.outbound.sendText({ cfg, to: "user:Chen", text: "p12-channel-ok" });
    expect(ok).toMatchObject({ channel: "wecom-app", ok: true });
    expect(ok.transportAck?.accepted).toBe(true);

    mockSendText.mockResolvedValueOnce({ ok: false, errcode: 81013, errmsg: "user invalid" });
    await expect(wecomAppPlugin.outbound.sendText({ cfg, to: "user:Chen", text: "p12-channel-fail" }))
      .rejects.toThrow("user invalid");
  }, 15000);
});
