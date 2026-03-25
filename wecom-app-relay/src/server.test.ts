/**
 * wecom-app-relay server 单元测试
 *
 * 覆盖：
 * - WebSocket 认证（token / 企微凭证 / 失败 / 超时）
 * - 入站：企微回调 GET 验证 + POST 消息转发
 * - 出站：webhook 响应 → 企微 API 代发
 * - 安全：session 校验、速率限制、请求体限制、后连接顶替
 * - 健康检查
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { WebSocket } from "ws";

import { createRelayServer } from "./server.js";
import { encrypt, computeMsgSignature } from "./wecom-crypto.js";
import type { RelayConfig } from "./config.js";

// ── Mock wecom-api to avoid real HTTP calls ──
vi.mock("./wecom-api.js", () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ ok: true, errcode: 0, errmsg: "ok" }),
}));
import { sendTextMessage } from "./wecom-api.js";
const mockSendText = vi.mocked(sendTextMessage);

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TEST_TOKEN = "test_callback_token_12345";
const TEST_AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const TEST_CORP_ID = "ww_test_corp";
const TEST_CORP_SECRET = "test_secret";
const TEST_AGENT_ID = 1000001;
const TEST_AUTH_TOKEN = "relay_auth_secret_token";

function buildConfig(overrides?: Partial<RelayConfig>): RelayConfig {
  return {
    host: "127.0.0.1",
    port: 0, // random port
    authToken: TEST_AUTH_TOKEN,
    accounts: {
      default: {
        token: TEST_TOKEN,
        encodingAESKey: TEST_AES_KEY,
        receiveId: TEST_CORP_ID,
        corpId: TEST_CORP_ID,
        corpSecret: TEST_CORP_SECRET,
        agentId: TEST_AGENT_ID,
        apiBaseUrl: "https://qyapi.weixin.qq.com",
        webhookPath: "/wecom",
      },
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getPort(server: { server: http.Server }): number {
  const addr = server.server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function wsRecv(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws recv timeout")), timeoutMs);
    ws.once("message", (data: Buffer | string) => {
      clearTimeout(timer);
      resolve(JSON.parse(typeof data === "string" ? data : data.toString("utf8")));
    });
  });
}

function authWithToken(ws: WebSocket): Promise<Record<string, unknown>> {
  ws.send(JSON.stringify({ type: "auth", user_id: "test-user", token: TEST_AUTH_TOKEN }));
  return wsRecv(ws);
}

function authWithCredentials(ws: WebSocket): Promise<Record<string, unknown>> {
  ws.send(JSON.stringify({
    type: "auth",
    user_id: "test-user",
    platform: "wecom",
    wecom_corp_id: TEST_CORP_ID,
    wecom_agent_id: String(TEST_AGENT_ID),
    wecom_secret: TEST_CORP_SECRET,
    wecom_token: TEST_TOKEN,
    wecom_aes_key: TEST_AES_KEY,
  }));
  return wsRecv(ws);
}

function httpRequest(port: number, opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method: opts.method,
      path: opts.path,
      headers: opts.headers,
    }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** HTTP request returning raw buffer + headers (for binary proxy tests) */
function httpRequestRaw(port: number, opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; headers: Record<string, string>; bodyBuffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method: opts.method,
      path: opts.path,
      headers: opts.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers[k] = v;
        }
        resolve({ status: res.statusCode ?? 0, headers, bodyBuffer: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Build encrypted WeCom callback query params for GET verification */
function buildVerifyParams() {
  const echostr = encrypt(TEST_AES_KEY, TEST_CORP_ID, "verify_ok_12345");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "test_nonce";
  const signature = computeMsgSignature(TEST_TOKEN, timestamp, nonce, echostr);
  return { echostr, timestamp, nonce, signature };
}

/** Build encrypted WeCom POST callback body */
function buildCallbackBody(plainXml: string) {
  const encrypted = encrypt(TEST_AES_KEY, TEST_CORP_ID, plainXml);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "post_nonce";
  const signature = computeMsgSignature(TEST_TOKEN, timestamp, nonce, encrypted);
  const xmlBody = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
  return { xmlBody, timestamp, nonce, signature };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("relay server", () => {
  let relay: ReturnType<typeof createRelayServer> | null = null;
  const openWs: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of openWs) {
      try { ws.close(); } catch {}
    }
    openWs.length = 0;
    if (relay) {
      await relay.stop();
      relay = null;
    }
    mockSendText.mockClear();
  });

  async function startRelay(overrides?: Partial<RelayConfig>) {
    relay = createRelayServer(buildConfig(overrides));
    await relay.start();
    return relay;
  }

  async function connectAndAuth(port: number, method: "token" | "credentials" = "token") {
    const ws = await connectWs(port);
    openWs.push(ws);
    const result = method === "token" ? await authWithToken(ws) : await authWithCredentials(ws);
    return { ws, result };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Auth
  // ════════════════════════════════════════════════════════════════════════════

  describe("auth", () => {
    it("accepts token-based auth", async () => {
      const r = await startRelay();
      const { result } = await connectAndAuth(getPort(r), "token");
      expect(result.success).toBe(true);
      expect(result.session_id).toBeTruthy();
      expect(r.clients.size).toBe(1);
    });

    it("returns server_version and capabilities in auth_result", async () => {
      const r = await startRelay();
      const { result } = await connectAndAuth(getPort(r), "token");
      expect(result.success).toBe(true);
      expect(typeof result.server_version).toBe("string");
      expect((result.server_version as string).length).toBeGreaterThan(0);
      expect(result.capabilities).toEqual({ media_proxy: true });
    });

    it("accepts lsbot-style credential auth", async () => {
      const r = await startRelay();
      const { result } = await connectAndAuth(getPort(r), "credentials");
      expect(result.success).toBe(true);
      expect(result.session_id).toBeTruthy();
    });

    it("rejects invalid token", async () => {
      const r = await startRelay();
      const ws = await connectWs(getPort(r));
      openWs.push(ws);
      ws.send(JSON.stringify({ type: "auth", user_id: "u", token: "wrong_token" }));
      const result = await wsRecv(ws);
      expect(result.success).toBe(false);
      expect(result.error).toBe("invalid credentials");
    });

    it("rejects missing user_id", async () => {
      const r = await startRelay();
      const ws = await connectWs(getPort(r));
      openWs.push(ws);
      ws.send(JSON.stringify({ type: "auth", token: TEST_AUTH_TOKEN }));
      const result = await wsRecv(ws);
      expect(result.success).toBe(false);
      expect(result.error).toBe("user_id required");
    });

    it("rejects unmatched corp_id + agent_id", async () => {
      const r = await startRelay();
      const ws = await connectWs(getPort(r));
      openWs.push(ws);
      ws.send(JSON.stringify({
        type: "auth",
        user_id: "u",
        wecom_corp_id: "wrong_corp",
        wecom_agent_id: "9999",
      }));
      const result = await wsRecv(ws);
      expect(result.success).toBe(false);
    });

    it("displaces previous client on same account (last-connect-wins)", async () => {
      const r = await startRelay();
      const port = getPort(r);

      const { ws: ws1 } = await connectAndAuth(port, "token");
      expect(r.clients.size).toBe(1);

      const closePromise = new Promise<number>((resolve) => {
        ws1.on("close", (code) => resolve(code));
      });

      // Second client connects - should displace first
      const { ws: ws2, result: r2 } = await connectAndAuth(port, "token");
      expect(r2.success).toBe(true);

      const closeCode = await closePromise;
      expect(closeCode).toBe(1008);
      expect(r.clients.size).toBe(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Inbound: WeCom callback → client
  // ════════════════════════════════════════════════════════════════════════════

  describe("wecom callback (inbound)", () => {
    it("handles GET URL verification", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { echostr, timestamp, nonce, signature } = buildVerifyParams();

      const resp = await httpRequest(port, {
        method: "GET",
        path: `/wecom?msg_signature=${encodeURIComponent(signature)}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`,
      });

      expect(resp.status).toBe(200);
      expect(resp.body).toBe("verify_ok_12345");
    });

    it("rejects GET with wrong signature", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { echostr, timestamp, nonce } = buildVerifyParams();

      const resp = await httpRequest(port, {
        method: "GET",
        path: `/wecom?msg_signature=wrong_sig&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`,
      });

      expect(resp.status).toBe(403);
    });

    it("rejects GET without required params", async () => {
      const r = await startRelay();
      const resp = await httpRequest(getPort(r), { method: "GET", path: "/wecom" });
      expect(resp.status).toBe(400);
    });

    it("forwards POST callback as wecom_raw to connected client", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { ws } = await connectAndAuth(port, "token");

      const plainXml = `<xml><FromUserName><![CDATA[Alice]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content><MsgId>123</MsgId></xml>`;
      const { xmlBody, timestamp, nonce, signature } = buildCallbackBody(plainXml);

      // Listen for forwarded message
      const msgPromise = wsRecv(ws);

      const resp = await httpRequest(port, {
        method: "POST",
        path: `/wecom?msg_signature=${encodeURIComponent(signature)}&timestamp=${timestamp}&nonce=${nonce}`,
        headers: { "Content-Type": "application/xml" },
        body: xmlBody,
      });

      expect(resp.status).toBe(200);
      const parsed = JSON.parse(resp.body);
      expect(parsed.errcode).toBe(0);

      // Verify client received wecom_raw
      const relayMsg = await msgPromise;
      expect(relayMsg.type).toBe("wecom_raw");
      expect(relayMsg.msg_signature).toBe(signature);
      expect(relayMsg.timestamp).toBe(timestamp);
      expect(relayMsg.nonce).toBe(nonce);
      expect(typeof relayMsg.body).toBe("string");
      expect(relayMsg.body).toContain("<Encrypt>");
    });

    it("returns 200 even when no client is connected (message dropped)", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { xmlBody, timestamp, nonce, signature } = buildCallbackBody("<xml><Content>test</Content></xml>");

      const resp = await httpRequest(port, {
        method: "POST",
        path: `/wecom?msg_signature=${encodeURIComponent(signature)}&timestamp=${timestamp}&nonce=${nonce}`,
        headers: { "Content-Type": "application/xml" },
        body: xmlBody,
      });

      // Must still return 200 to WeCom (avoid retry storm)
      expect(resp.status).toBe(200);
    });

    it("rejects unsupported HTTP methods on callback path", async () => {
      const r = await startRelay();
      const resp = await httpRequest(getPort(r), { method: "PUT", path: "/wecom?msg_signature=x&timestamp=1&nonce=n" });
      expect(resp.status).toBe(405);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Outbound: client response → WeCom API
  // ════════════════════════════════════════════════════════════════════════════

  describe("webhook response (outbound)", () => {
    it("forwards client response to WeCom API via sendTextMessage", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { result } = await connectAndAuth(port, "token");
      const sessionId = result.session_id as string;

      const resp = await httpRequest(port, {
        method: "POST",
        path: "/webhook",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": sessionId,
        },
        body: JSON.stringify({
          type: "response",
          message_id: "msg1",
          platform: "wecom",
          channel_id: "UserA",
          text: "hi from bot",
        }),
      });

      expect(resp.status).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.ok).toBe(true);

      // Verify sendTextMessage was called correctly
      expect(mockSendText).toHaveBeenCalledTimes(1);
      const [account, userId, text] = mockSendText.mock.calls[0]!;
      expect(account.corpId).toBe(TEST_CORP_ID);
      expect(userId).toBe("UserA");
      expect(text).toBe("hi from bot");
    });

    it("rejects webhook without valid session", async () => {
      const r = await startRelay();
      const port = getPort(r);

      const resp = await httpRequest(port, {
        method: "POST",
        path: "/webhook",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": "nonexistent_session",
        },
        body: JSON.stringify({ channel_id: "u", text: "hi" }),
      });

      expect(resp.status).toBe(401);
      expect(mockSendText).not.toHaveBeenCalled();
    });

    it("rejects webhook without session header", async () => {
      const r = await startRelay();
      const resp = await httpRequest(getPort(r), {
        method: "POST",
        path: "/webhook",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: "u", text: "hi" }),
      });
      expect(resp.status).toBe(401);
    });

    it("rejects webhook with missing channel_id or text", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { result } = await connectAndAuth(port, "token");

      const resp = await httpRequest(port, {
        method: "POST",
        path: "/webhook",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": result.session_id as string,
        },
        body: JSON.stringify({ channel_id: "u" }), // missing text
      });

      expect(resp.status).toBe(400);
    });

    it("rejects webhook with invalid JSON", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { result } = await connectAndAuth(port, "token");

      const resp = await httpRequest(port, {
        method: "POST",
        path: "/webhook",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": result.session_id as string,
        },
        body: "not json{{{",
      });

      expect(resp.status).toBe(400);
    });

    it("returns 502 when WeCom API call fails", async () => {
      mockSendText.mockRejectedValueOnce(new Error("network error"));

      const r = await startRelay();
      const port = getPort(r);
      const { result } = await connectAndAuth(port, "token");

      const resp = await httpRequest(port, {
        method: "POST",
        path: "/webhook",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": result.session_id as string,
        },
        body: JSON.stringify({ channel_id: "u", text: "hi" }),
      });

      expect(resp.status).toBe(502);
      const body = JSON.parse(resp.body);
      expect(body.ok).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Outbound: send_message via WebSocket → WeCom API
  // ════════════════════════════════════════════════════════════════════════════

  describe("send_message (outbound via WebSocket)", () => {
    it("proxies send_message to WeCom API and returns send_result", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { ws } = await connectAndAuth(port, "token");

      // Send a send_message request
      ws.send(JSON.stringify({
        type: "send_message",
        id: "req_001",
        platform: "wecom",
        channel_id: "UserA",
        text: "hello from cron",
      }));

      const result = await wsRecv(ws);
      expect(result.type).toBe("send_result");
      expect(result.id).toBe("req_001");
      expect(result.ok).toBe(true);
      expect(result.errcode).toBe(0);

      // Verify sendTextMessage was called
      expect(mockSendText).toHaveBeenCalledTimes(1);
      const [account, userId, text] = mockSendText.mock.calls[0]!;
      expect(account.corpId).toBe(TEST_CORP_ID);
      expect(userId).toBe("UserA");
      expect(text).toBe("hello from cron");
    });

    it("returns error when WeCom API call fails", async () => {
      mockSendText.mockRejectedValueOnce(new Error("api down"));

      const r = await startRelay();
      const port = getPort(r);
      const { ws } = await connectAndAuth(port, "token");

      ws.send(JSON.stringify({
        type: "send_message",
        id: "req_fail",
        channel_id: "UserB",
        text: "should fail",
      }));

      const result = await wsRecv(ws);
      expect(result.type).toBe("send_result");
      expect(result.id).toBe("req_fail");
      expect(result.ok).toBe(false);
      expect(result.errmsg).toContain("api down");
    });

    it("returns error for missing channel_id", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { ws } = await connectAndAuth(port, "token");

      ws.send(JSON.stringify({
        type: "send_message",
        id: "req_no_channel",
        text: "no target",
      }));

      const result = await wsRecv(ws);
      expect(result.type).toBe("send_result");
      expect(result.ok).toBe(false);
      expect(result.errmsg).toContain("channel_id and text required");
      expect(mockSendText).not.toHaveBeenCalled();
    });

    it("returns error for missing text", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { ws } = await connectAndAuth(port, "token");

      ws.send(JSON.stringify({
        type: "send_message",
        id: "req_no_text",
        channel_id: "UserA",
      }));

      const result = await wsRecv(ws);
      expect(result.type).toBe("send_result");
      expect(result.ok).toBe(false);
      expect(mockSendText).not.toHaveBeenCalled();
    });

    it("ignores send_message from unauthenticated client", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const ws = await connectWs(port);
      openWs.push(ws);

      // Send before auth - should be ignored (no crash)
      ws.send(JSON.stringify({
        type: "send_message",
        id: "req_unauth",
        channel_id: "UserA",
        text: "sneaky",
      }));

      // Small delay to ensure no crash
      await new Promise((r) => setTimeout(r, 200));
      expect(mockSendText).not.toHaveBeenCalled();
    });

    it("works with credential-based auth", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { ws } = await connectAndAuth(port, "credentials");

      ws.send(JSON.stringify({
        type: "send_message",
        id: "req_cred",
        channel_id: "UserC",
        text: "via credentials",
      }));

      const result = await wsRecv(ws);
      expect(result.type).toBe("send_result");
      expect(result.ok).toBe(true);

      expect(mockSendText).toHaveBeenCalledTimes(1);
      expect(mockSendText.mock.calls[0]![1]).toBe("UserC");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Health check
  // ════════════════════════════════════════════════════════════════════════════

  describe("health check", () => {
    it("returns status with client count", async () => {
      const r = await startRelay();
      const port = getPort(r);

      // No clients
      let resp = await httpRequest(port, { method: "GET", path: "/health" });
      expect(resp.status).toBe(200);
      let body = JSON.parse(resp.body);
      expect(body.ok).toBe(true);
      expect(body.clients).toBe(0);

      // Connect a client
      await connectAndAuth(port, "token");

      resp = await httpRequest(port, { method: "GET", path: "/health" });
      body = JSON.parse(resp.body);
      expect(body.clients).toBe(1);
      expect(body.accounts.default).toBeTruthy();
      expect(body.accounts.default.connected).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Security
  // ════════════════════════════════════════════════════════════════════════════

  describe("security", () => {
    it("returns 404 for unknown paths", async () => {
      const r = await startRelay();
      const resp = await httpRequest(getPort(r), { method: "GET", path: "/unknown" });
      expect(resp.status).toBe(404);
    });

    it("handles ping/pong heartbeat", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { ws } = await connectAndAuth(port, "token");

      // Server sends ping, client should respond with pong automatically
      // (our client code does this). Here we test that server sends ping.
      // We manually send a pong to verify it's accepted.
      ws.send(JSON.stringify({ type: "pong" }));

      // Small wait - no error should occur
      await new Promise((r) => setTimeout(r, 200));
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it("supports custom webhookPath per account", async () => {
      const r = await startRelay({
        accounts: {
          custom: {
            ...buildConfig().accounts.default,
            webhookPath: "/custom/callback",
          },
        },
      });
      const port = getPort(r);
      const { echostr, timestamp, nonce, signature } = buildVerifyParams();

      // Default path should 404
      let resp = await httpRequest(port, { method: "GET", path: `/wecom?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}` });
      expect(resp.status).toBe(404);

      // Custom path should work
      resp = await httpRequest(port, {
        method: "GET",
        path: `/custom/callback?msg_signature=${encodeURIComponent(signature)}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`,
      });
      expect(resp.status).toBe(200);
      expect(resp.body).toBe("verify_ok_12345");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Media proxy
  // ════════════════════════════════════════════════════════════════════════════

  describe("media proxy", () => {
    it("rejects request without valid session", async () => {
      const r = await startRelay();
      const resp = await httpRequest(getPort(r), {
        method: "GET",
        path: "/media/proxy?media_id=mid1&access_token=tok1",
        headers: { "X-Session-ID": "nonexistent_session" },
      });
      expect(resp.status).toBe(401);
    });

    it("rejects request without session header", async () => {
      const r = await startRelay();
      const resp = await httpRequest(getPort(r), {
        method: "GET",
        path: "/media/proxy?media_id=mid1&access_token=tok1",
      });
      expect(resp.status).toBe(401);
    });

    it("rejects request with missing media_id", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { result } = await connectAndAuth(port, "token");
      const sessionId = result.session_id as string;

      const resp = await httpRequest(port, {
        method: "GET",
        path: "/media/proxy?access_token=tok1",
        headers: { "X-Session-ID": sessionId },
      });
      expect(resp.status).toBe(400);
      expect(resp.body).toContain("media_id");
    });

    it("rejects request with missing access_token", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { result } = await connectAndAuth(port, "token");
      const sessionId = result.session_id as string;

      const resp = await httpRequest(port, {
        method: "GET",
        path: "/media/proxy?media_id=mid1",
        headers: { "X-Session-ID": sessionId },
      });
      expect(resp.status).toBe(400);
      expect(resp.body).toContain("access_token");
    });

    it("proxies media download from WeCom API and streams response", async () => {
      const mediaContent = Buffer.from("fake-image-content-png");
      const originalFetch = globalThis.fetch;

      // Mock fetch to simulate WeCom API response
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/cgi-bin/media/get")) {
          return new Response(mediaContent, {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Content-Disposition": 'attachment; filename="test.png"',
              "Content-Length": String(mediaContent.length),
            },
          });
        }
        return originalFetch(url as RequestInfo, undefined);
      }) as typeof fetch;

      try {
        const r = await startRelay();
        const port = getPort(r);
        const { result } = await connectAndAuth(port, "token");
        const sessionId = result.session_id as string;

        const resp = await httpRequestRaw(port, {
          method: "GET",
          path: "/media/proxy?media_id=mid1&access_token=tok1",
          headers: { "X-Session-ID": sessionId },
        });

        expect(resp.status).toBe(200);
        expect(resp.headers["content-type"]).toBe("image/png");
        expect(resp.headers["content-disposition"]).toBe('attachment; filename="test.png"');
        expect(resp.bodyBuffer.toString()).toBe(mediaContent.toString());
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("passes through WeCom API error responses (e.g., JSON error)", async () => {
      const errorJson = JSON.stringify({ errcode: 40007, errmsg: "invalid media_id" });
      const originalFetch = globalThis.fetch;

      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/cgi-bin/media/get")) {
          return new Response(errorJson, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(url as RequestInfo, undefined);
      }) as typeof fetch;

      try {
        const r = await startRelay();
        const port = getPort(r);
        const { result } = await connectAndAuth(port, "token");
        const sessionId = result.session_id as string;

        const resp = await httpRequest(port, {
          method: "GET",
          path: "/media/proxy?media_id=bad_id&access_token=tok1",
          headers: { "X-Session-ID": sessionId },
        });

        expect(resp.status).toBe(200); // WeCom returns 200 even for errors
        const body = JSON.parse(resp.body);
        expect(body.errcode).toBe(40007);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns 502 when upstream fetch fails", async () => {
      const originalFetch = globalThis.fetch;

      globalThis.fetch = (async () => {
        throw new Error("network error");
      }) as typeof fetch;

      try {
        const r = await startRelay();
        const port = getPort(r);
        const { result } = await connectAndAuth(port, "token");
        const sessionId = result.session_id as string;

        const resp = await httpRequest(port, {
          method: "GET",
          path: "/media/proxy?media_id=mid1&access_token=tok1",
          headers: { "X-Session-ID": sessionId },
        });

        expect(resp.status).toBe(502);
        const body = JSON.parse(resp.body);
        expect(body.ok).toBe(false);
        expect(body.error).toContain("network error");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("uses account apiBaseUrl for upstream request", async () => {
      const customApiBase = "https://custom-proxy.example.com";
      let capturedUrl = "";
      const originalFetch = globalThis.fetch;

      globalThis.fetch = (async (url: string | URL | Request) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        return new Response("ok", {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }) as typeof fetch;

      try {
        const r = await startRelay({
          accounts: {
            default: {
              ...buildConfig().accounts.default,
              apiBaseUrl: customApiBase,
            },
          },
        });
        const port = getPort(r);
        const { result } = await connectAndAuth(port, "token");
        const sessionId = result.session_id as string;

        await httpRequest(port, {
          method: "GET",
          path: "/media/proxy?media_id=mid1&access_token=tok1",
          headers: { "X-Session-ID": sessionId },
        });

        expect(capturedUrl).toContain(customApiBase);
        expect(capturedUrl).toContain("/cgi-bin/media/get");
        expect(capturedUrl).toContain("media_id=mid1");
        expect(capturedUrl).toContain("access_token=tok1");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Offline message buffering
  // ════════════════════════════════════════════════════════════════════════════

  describe("offline message buffering", () => {
    it("buffers messages when no client is connected and flushes on reconnect", async () => {
      const r = await startRelay();
      const port = getPort(r);

      // Send a WeCom callback without any client connected
      const plainXml = `<xml><FromUserName><![CDATA[Alice]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[offline msg]]></Content><MsgId>buf_001</MsgId></xml>`;
      const { xmlBody, timestamp, nonce, signature } = buildCallbackBody(plainXml);

      const resp = await httpRequest(port, {
        method: "POST",
        path: `/wecom?msg_signature=${encodeURIComponent(signature)}&timestamp=${timestamp}&nonce=${nonce}`,
        headers: { "Content-Type": "application/xml" },
        body: xmlBody,
      });
      expect(resp.status).toBe(200);

      // Verify message is buffered
      expect(r.offlineBuffer.get("default")?.length).toBe(1);

      // Now connect a client — collect auth_result + flushed messages
      const ws = await connectWs(port);
      openWs.push(ws);

      // Collect messages (auth_result will be sent after auth, then buffered messages)
      const msgs: Record<string, unknown>[] = [];
      const collectPromise = new Promise<void>((resolve) => {
        ws.on("message", (data: Buffer | string) => {
          msgs.push(JSON.parse(typeof data === "string" ? data : data.toString("utf8")));
          if (msgs.length >= 2) resolve();
        });
        setTimeout(resolve, 3000);
      });

      ws.send(JSON.stringify({ type: "auth", user_id: "test-user", token: TEST_AUTH_TOKEN }));
      await collectPromise;

      expect(msgs[0]!.type).toBe("auth_result");
      expect(msgs[1]!.type).toBe("wecom_raw");
      expect(msgs[1]!.msg_signature).toBe(signature);

      // Buffer should be cleared after flush
      expect(r.offlineBuffer.get("default")).toBeUndefined();
    });

    it("buffers multiple messages and flushes all on reconnect", async () => {
      const r = await startRelay();
      const port = getPort(r);

      // Send two WeCom callbacks without client
      for (let i = 0; i < 2; i++) {
        const plainXml = `<xml><Content><![CDATA[msg ${i}]]></Content><MsgId>multi_${i}</MsgId></xml>`;
        const { xmlBody, timestamp, nonce, signature } = buildCallbackBody(plainXml);
        await httpRequest(port, {
          method: "POST",
          path: `/wecom?msg_signature=${encodeURIComponent(signature)}&timestamp=${timestamp}&nonce=${nonce}`,
          headers: { "Content-Type": "application/xml" },
          body: xmlBody,
        });
      }

      expect(r.offlineBuffer.get("default")?.length).toBe(2);

      // Connect client — should receive auth_result + 2 buffered messages
      const ws = await connectWs(port);
      openWs.push(ws);

      const msgs: Record<string, unknown>[] = [];
      const collectPromise = new Promise<void>((resolve) => {
        ws.on("message", (data: Buffer | string) => {
          msgs.push(JSON.parse(typeof data === "string" ? data : data.toString("utf8")));
          if (msgs.length >= 3) resolve();
        });
        setTimeout(resolve, 3000);
      });

      ws.send(JSON.stringify({ type: "auth", user_id: "test-user", token: TEST_AUTH_TOKEN }));
      await collectPromise;

      expect(msgs[0]!.type).toBe("auth_result");
      expect(msgs[1]!.type).toBe("wecom_raw");
      expect(msgs[2]!.type).toBe("wecom_raw");

      expect(r.offlineBuffer.get("default")).toBeUndefined();
    });

    it("does not buffer when client is connected (sends directly)", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { ws } = await connectAndAuth(port, "token");

      const plainXml = `<xml><Content><![CDATA[online msg]]></Content><MsgId>online_001</MsgId></xml>`;
      const { xmlBody, timestamp, nonce, signature } = buildCallbackBody(plainXml);

      const msgPromise = wsRecv(ws);
      await httpRequest(port, {
        method: "POST",
        path: `/wecom?msg_signature=${encodeURIComponent(signature)}&timestamp=${timestamp}&nonce=${nonce}`,
        headers: { "Content-Type": "application/xml" },
        body: xmlBody,
      });

      const msg = await msgPromise;
      expect(msg.type).toBe("wecom_raw");

      // Nothing in the buffer
      expect(r.offlineBuffer.get("default")).toBeUndefined();
    });

    it("drops oldest message when buffer is full", async () => {
      const r = await startRelay();
      const port = getPort(r);

      // Manually fill the buffer to capacity (200 messages)
      const buf: Array<{ payload: string; receivedAt: number }> = [];
      for (let i = 0; i < 200; i++) {
        buf.push({ payload: JSON.stringify({ type: "wecom_raw", idx: i }), receivedAt: Date.now() });
      }
      r.offlineBuffer.set("default", buf);

      // Send one more callback → should drop oldest
      const plainXml = `<xml><Content><![CDATA[overflow]]></Content><MsgId>overflow_001</MsgId></xml>`;
      const { xmlBody, timestamp, nonce, signature } = buildCallbackBody(plainXml);

      await httpRequest(port, {
        method: "POST",
        path: `/wecom?msg_signature=${encodeURIComponent(signature)}&timestamp=${timestamp}&nonce=${nonce}`,
        headers: { "Content-Type": "application/xml" },
        body: xmlBody,
      });

      const updatedBuf = r.offlineBuffer.get("default")!;
      expect(updatedBuf.length).toBe(200); // still 200, oldest dropped
      // First message should now be idx=1 (idx=0 was dropped)
      expect(JSON.parse(updatedBuf[0]!.payload).idx).toBe(1);
      // Last message should be the new wecom_raw
      expect(JSON.parse(updatedBuf[199]!.payload).type).toBe("wecom_raw");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // End-to-end: callback → client → webhook → WeCom API
  // ════════════════════════════════════════════════════════════════════════════

  describe("end-to-end flow", () => {
    it("full round-trip: WeCom callback → wecom_raw → client → webhook → sendTextMessage", async () => {
      const r = await startRelay();
      const port = getPort(r);
      const { ws, result: authResult } = await connectAndAuth(port, "token");
      const sessionId = authResult.session_id as string;

      // 1. Simulate WeCom POST callback
      const plainXml = `<xml><FromUserName><![CDATA[TestUser]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[ping]]></Content><MsgId>e2e_001</MsgId></xml>`;
      const { xmlBody, timestamp, nonce, signature } = buildCallbackBody(plainXml);

      const msgPromise = wsRecv(ws);

      await httpRequest(port, {
        method: "POST",
        path: `/wecom?msg_signature=${encodeURIComponent(signature)}&timestamp=${timestamp}&nonce=${nonce}`,
        headers: { "Content-Type": "application/xml" },
        body: xmlBody,
      });

      // 2. Client receives wecom_raw
      const relayMsg = await msgPromise;
      expect(relayMsg.type).toBe("wecom_raw");

      // 3. Client sends response via webhook
      const webhookResp = await httpRequest(port, {
        method: "POST",
        path: "/webhook",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": sessionId,
          "X-User-ID": "test-user",
        },
        body: JSON.stringify({
          type: "response",
          message_id: "e2e_001",
          platform: "wecom",
          channel_id: "TestUser",
          text: "pong",
        }),
      });

      expect(webhookResp.status).toBe(200);

      // 4. Verify WeCom API was called
      expect(mockSendText).toHaveBeenCalledTimes(1);
      const [account, userId, text] = mockSendText.mock.calls[0]!;
      expect(userId).toBe("TestUser");
      expect(text).toBe("pong");
      expect(account.agentId).toBe(TEST_AGENT_ID);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wecom-crypto unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("wecom-crypto", () => {
  it("encrypt then decrypt round-trip", async () => {
    const { decrypt: dec } = await import("./wecom-crypto.js");
    const plaintext = "hello 你好 world";
    const encrypted = encrypt(TEST_AES_KEY, TEST_CORP_ID, plaintext);
    const decrypted = dec(TEST_AES_KEY, TEST_CORP_ID, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("signature computation is deterministic", () => {
    const sig1 = computeMsgSignature(TEST_TOKEN, "123", "nonce", "enc");
    const sig2 = computeMsgSignature(TEST_TOKEN, "123", "nonce", "enc");
    expect(sig1).toBe(sig2);
    expect(sig1.length).toBe(40); // SHA1 hex
  });

  it("rejects wrong receiveId on decrypt", async () => {
    const { decrypt: dec } = await import("./wecom-crypto.js");
    const encrypted = encrypt(TEST_AES_KEY, TEST_CORP_ID, "test");
    expect(() => dec(TEST_AES_KEY, "wrong_corp", encrypted)).toThrow("receiveId mismatch");
  });

  it("rejects invalid encodingAESKey", () => {
    expect(() => encrypt("short", TEST_CORP_ID, "test")).toThrow();
  });
});
