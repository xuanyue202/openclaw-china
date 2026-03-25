/**
 * Relay Server — HTTP + WebSocket
 *
 * 实现 lsbot relay 协议兼容的中继服务器：
 * - WebSocket /ws: 接受 extension 客户端连接
 * - HTTP /wecom: 接收企微回调
 * - HTTP /webhook: 接收客户端响应
 * - HTTP /health: 健康检查
 */

import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

import { createRequire } from "node:module";
import type { RelayConfig, AccountConfig } from "./config.js";
import { verifySignature, decrypt } from "./wecom-crypto.js";
import { sendTextMessage } from "./wecom-api.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json") as { version: string };

// ─────────────────────────────────────────────────────────────────────────────
// Security constants
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 90_000;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1MB
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MESSAGES = 120;
const OFFLINE_BUFFER_MAX = 200;
const OFFLINE_BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ConnectedClient = {
  ws: WebSocket;
  sessionId: string;
  userId: string;
  accountIds: Set<string>;
  authenticatedAt: number;
  lastPongAt: number;
  messageCount: number;
  rateLimitResetAt: number;
};

type BufferedMessage = {
  payload: string; // JSON-serialized relay message
  receivedAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Security utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Constant-time string comparison to prevent timing attacks */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Read request body with size limit */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      bytes += Buffer.byteLength(str, "utf8");
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      body += str;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Check rate limit for a client */
function checkRateLimit(client: ConnectedClient): boolean {
  const now = Date.now();
  if (now > client.rateLimitResetAt) {
    client.messageCount = 0;
    client.rateLimitResetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  client.messageCount++;
  return client.messageCount <= RATE_LIMIT_MAX_MESSAGES;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────

export function createRelayServer(config: RelayConfig) {
  const clients = new Map<string, ConnectedClient>();
  const accountToClient = new Map<string, string>(); // accountKey → sessionId
  const offlineBuffer = new Map<string, BufferedMessage[]>(); // accountId → buffered messages

  const log = (msg: string) => console.log(`[relay] ${msg}`);
  const error = (msg: string) => console.error(`[relay] ${msg}`);

  /** Buffer a message for an offline account */
  function bufferMessage(accountId: string, payload: string): void {
    let buf = offlineBuffer.get(accountId);
    if (!buf) {
      buf = [];
      offlineBuffer.set(accountId, buf);
    }
    // Evict expired entries
    const now = Date.now();
    while (buf.length > 0 && now - buf[0]!.receivedAt > OFFLINE_BUFFER_TTL_MS) {
      buf.shift();
    }
    // Enforce max size
    if (buf.length >= OFFLINE_BUFFER_MAX) {
      buf.shift();
      log(`[${accountId}] offline buffer full, oldest message dropped`);
    }
    buf.push({ payload, receivedAt: now });
  }

  /** Flush buffered messages to a newly connected client */
  function flushBufferedMessages(accountId: string, client: ConnectedClient): void {
    const buf = offlineBuffer.get(accountId);
    if (!buf || buf.length === 0) return;

    const now = Date.now();
    let sent = 0;
    for (const msg of buf) {
      if (now - msg.receivedAt > OFFLINE_BUFFER_TTL_MS) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg.payload);
        sent++;
      }
    }
    offlineBuffer.delete(accountId);
    if (sent > 0) {
      log(`[${accountId}] flushed ${sent} buffered message(s) to client ${client.sessionId}`);
    }
  }

  // ── HTTP server ──
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    // Health check
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        clients: clients.size,
        accounts: Object.fromEntries(
          [...accountToClient.entries()].map(([k, v]) => [k, { sessionId: v, connected: clients.has(v) }]),
        ),
      }));
      return;
    }

    // WeCom callback
    for (const [accountId, accountCfg] of Object.entries(config.accounts)) {
      const webhookPath = accountCfg.webhookPath.replace(/\/+$/, "") || "/wecom";
      if (pathname === webhookPath) {
        await handleWecomCallback(req, res, accountId, accountCfg, url.searchParams);
        return;
      }
    }

    // Media proxy: relay downloads media from WeCom API on behalf of client
    if (req.method === "GET" && pathname === "/media/proxy") {
      await handleMediaProxy(req, res, url.searchParams);
      return;
    }

    // Webhook response from client
    if (req.method === "POST" && pathname === "/webhook") {
      await handleWebhookResponse(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  // ── WebSocket server ──
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    let client: ConnectedClient | null = null;
    let authTimer: ReturnType<typeof setTimeout> | undefined;

    // Auth timeout
    authTimer = setTimeout(() => {
      if (!client) {
        log("auth timeout, closing connection");
        ws.close(1008, "auth timeout");
      }
    }, AUTH_TIMEOUT_MS);

    ws.on("message", (data: Buffer | string) => {
      const text = typeof data === "string" ? data : data.toString("utf8");

      // Reject oversized messages
      if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BODY_BYTES) {
        error("ws message too large, closing");
        ws.close(1009, "message too large");
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      // Rate limiting (only for authenticated clients)
      if (client && !checkRateLimit(client)) {
        ws.send(JSON.stringify({ type: "error", code: "rate_limit", message: "too many messages" }));
        return;
      }

      if (msg.type === "auth") {
        handleAuth(ws, msg);
      } else if (msg.type === "pong") {
        if (client) client.lastPongAt = Date.now();
      } else if (msg.type === "send_message" && client) {
        handleSendMessage(client, msg);
      }
    });

    ws.on("close", () => {
      if (authTimer) clearTimeout(authTimer);
      if (client) {
        log(`client disconnected: ${client.sessionId} (user=${client.userId})`);
        clients.delete(client.sessionId);
        for (const aid of client.accountIds) {
          if (accountToClient.get(aid) === client.sessionId) {
            accountToClient.delete(aid);
          }
        }
      }
    });

    ws.on("error", (err) => {
      error(`ws error: ${String(err)}`);
    });

    function handleAuth(ws: WebSocket, msg: Record<string, unknown>) {
      if (authTimer) { clearTimeout(authTimer); authTimer = undefined; }

      // Validate auth token
      // Support lsbot-style auth (no token field, just platform credentials)
      // and our token-based auth
      const userId = String(msg.user_id ?? msg.userId ?? "");
      if (!userId) {
        ws.send(JSON.stringify({ type: "auth_result", success: false, error: "user_id required" }));
        ws.close(1008, "auth failed");
        return;
      }

      // Match account by credentials
      const matchedAccountIds = new Set<string>();
      const corpId = String(msg.wecom_corp_id ?? "");
      const agentIdStr = String(msg.wecom_agent_id ?? "");

      if (corpId && agentIdStr) {
        // lsbot-style: match by corp_id + agent_id
        for (const [aid, acfg] of Object.entries(config.accounts)) {
          if (acfg.corpId === corpId && String(acfg.agentId) === agentIdStr) {
            matchedAccountIds.add(aid);
          }
        }
      }

      // If no credential match, try auth token
      if (matchedAccountIds.size === 0) {
        const token = String(msg.token ?? msg.auth_token ?? "");
        if (token && safeCompare(token, config.authToken)) {
          // Token auth: grant access to all accounts
          for (const aid of Object.keys(config.accounts)) {
            matchedAccountIds.add(aid);
          }
        }
      }

      if (matchedAccountIds.size === 0) {
        ws.send(JSON.stringify({ type: "auth_result", success: false, error: "invalid credentials" }));
        ws.close(1008, "auth failed");
        return;
      }

      const sessionId = `sess_${crypto.randomBytes(16).toString("hex")}`;
      client = {
        ws,
        sessionId,
        userId,
        accountIds: matchedAccountIds,
        authenticatedAt: Date.now(),
        lastPongAt: Date.now(),
        messageCount: 0,
        rateLimitResetAt: Date.now() + RATE_LIMIT_WINDOW_MS,
      };

      // Disconnect previous client for same accounts (last-connect-wins)
      for (const aid of matchedAccountIds) {
        const prevSessionId = accountToClient.get(aid);
        if (prevSessionId) {
          const prev = clients.get(prevSessionId);
          if (prev) {
            log(`displacing previous client ${prevSessionId} for account ${aid}`);
            prev.ws.close(1008, "displaced by new connection");
            clients.delete(prevSessionId);
          }
        }
        accountToClient.set(aid, sessionId);
      }

      clients.set(sessionId, client);
      log(`client authenticated: session=${sessionId} user=${userId} accounts=[${[...matchedAccountIds].join(",")}]`);

      ws.send(JSON.stringify({
        type: "auth_result",
        success: true,
        session_id: sessionId,
        server_version: SERVER_VERSION,
        capabilities: { media_proxy: true },
      }));

      // Flush any buffered messages for the authenticated accounts
      for (const aid of matchedAccountIds) {
        flushBufferedMessages(aid, client);
      }
    }

    async function handleSendMessage(client: ConnectedClient, msg: Record<string, unknown>) {
      const requestId = String(msg.id ?? msg.request_id ?? "");
      const channelId = String(msg.channel_id ?? "");
      const text = String(msg.text ?? "");

      if (!channelId || !text) {
        client.ws.send(JSON.stringify({
          type: "send_result",
          id: requestId,
          ok: false,
          errcode: -1,
          errmsg: "channel_id and text required",
        }));
        return;
      }

      // Find the account for this client
      let targetAccount: AccountConfig | undefined;
      for (const aid of client.accountIds) {
        targetAccount = config.accounts[aid];
        if (targetAccount) break;
      }

      if (!targetAccount) {
        client.ws.send(JSON.stringify({
          type: "send_result",
          id: requestId,
          ok: false,
          errcode: -1,
          errmsg: "no account found for client",
        }));
        return;
      }

      try {
        const result = await sendTextMessage(targetAccount, channelId, text);
        log(`send_message → WeCom: userId=${channelId} ok=${result.ok} errcode=${result.errcode}`);
        client.ws.send(JSON.stringify({
          type: "send_result",
          id: requestId,
          ok: result.ok,
          errcode: result.errcode,
          errmsg: result.errmsg,
        }));
      } catch (err) {
        error(`send_message → WeCom failed: ${String(err)}`);
        client.ws.send(JSON.stringify({
          type: "send_result",
          id: requestId,
          ok: false,
          errcode: -1,
          errmsg: String(err),
        }));
      }
    }
  });

  // ── Ping interval ──
  const pingInterval = setInterval(() => {
    for (const [sessionId, client] of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type: "ping" }));
      }
      if (Date.now() - client.lastPongAt > PONG_TIMEOUT_MS) {
        log(`client ${sessionId} timed out`);
        client.ws.close(1008, "pong timeout");
      }
    }
  }, PING_INTERVAL_MS);

  // ── WeCom callback handler ──
  async function handleWecomCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    accountId: string,
    account: AccountConfig,
    params: URLSearchParams,
  ) {
    const signature = params.get("msg_signature") ?? params.get("signature") ?? "";
    const timestamp = params.get("timestamp") ?? "";
    const nonce = params.get("nonce") ?? "";
    const echostr = params.get("echostr") ?? "";

    // GET: URL verification
    if (req.method === "GET") {
      if (!echostr || !signature) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("missing params");
        return;
      }

      const valid = verifySignature(account.token, timestamp, nonce, echostr, signature);
      if (!valid) {
        log(`[${accountId}] GET verification failed`);
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("signature mismatch");
        return;
      }

      try {
        const plaintext = decrypt(account.encodingAESKey, account.receiveId || account.corpId, echostr);
        log(`[${accountId}] GET verification success`);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(plaintext);
      } catch (err) {
        error(`[${accountId}] GET decrypt failed: ${String(err)}`);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("decrypt error");
      }
      return;
    }

    // POST: message callback
    if (req.method === "POST") {
      let body: string;
      try {
        body = await readBody(req, MAX_REQUEST_BODY_BYTES);
      } catch {
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("request too large");
        return;
      }

      // Forward as wecom_raw to connected client
      const clientSessionId = accountToClient.get(accountId);
      const client = clientSessionId ? clients.get(clientSessionId) : undefined;

      const relayPayload = JSON.stringify({
        type: "wecom_raw",
        msg_signature: signature,
        timestamp,
        nonce,
        body,
      });

      if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(relayPayload);
        log(`[${accountId}] forwarded wecom_raw to client ${client.sessionId}`);
      } else {
        bufferMessage(accountId, relayPayload);
        log(`[${accountId}] no connected client, message buffered`);
      }

      // Return empty success to WeCom (must respond within 5s)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
      return;
    }

    res.writeHead(405);
    res.end("method not allowed");
  }

  // ── Webhook response handler ──
  async function handleWebhookResponse(req: http.IncomingMessage, res: http.ServerResponse) {
    const sessionId = req.headers["x-session-id"] as string ?? "";

    // Validate session exists (prevent unauthorized webhook calls)
    if (!sessionId || !clients.has(sessionId)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("invalid or expired session");
      return;
    }

    let body: string;
    try {
      body = await readBody(req, MAX_REQUEST_BODY_BYTES);
    } catch {
      res.writeHead(413);
      res.end("request too large");
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("invalid json");
      return;
    }

    const channelId = String(payload.channel_id ?? "");
    const text = String(payload.text ?? "");

    if (!channelId || !text) {
      res.writeHead(400);
      res.end("channel_id and text required");
      return;
    }

    // Find the account for this session
    let targetAccount: AccountConfig | undefined;
    for (const [aid, sid] of accountToClient) {
      if (sid === sessionId) {
        targetAccount = config.accounts[aid];
        break;
      }
    }

    if (!targetAccount) {
      res.writeHead(404);
      res.end("no account found for session");
      return;
    }

    // Send message via WeCom API
    try {
      const result = await sendTextMessage(targetAccount, channelId, text);
      log(`webhook response → WeCom: userId=${channelId} ok=${result.ok} errcode=${result.errcode}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.ok, errcode: result.errcode, errmsg: result.errmsg }));
    } catch (err) {
      error(`webhook → WeCom failed: ${String(err)}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
  }

  // ── Media proxy handler ──
  async function handleMediaProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    params: URLSearchParams,
  ) {
    // Authenticate via session ID
    const sessionId = req.headers["x-session-id"] as string ?? "";
    if (!sessionId || !clients.has(sessionId)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("invalid or expired session");
      return;
    }

    const mediaId = params.get("media_id") ?? "";
    const accessToken = params.get("access_token") ?? "";

    if (!mediaId || !accessToken) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("media_id and access_token required");
      return;
    }

    // Find the account for this session to get apiBaseUrl
    let targetAccount: AccountConfig | undefined;
    for (const [aid, sid] of accountToClient) {
      if (sid === sessionId) {
        targetAccount = config.accounts[aid];
        break;
      }
    }

    const apiBase = targetAccount?.apiBaseUrl ?? "https://qyapi.weixin.qq.com";
    const wecomUrl = `${apiBase}/cgi-bin/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`;

    try {
      const upstream = await fetch(wecomUrl);

      // Pass through status code, content-type, and content-disposition
      const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
      const contentDisposition = upstream.headers.get("content-disposition");
      const contentLength = upstream.headers.get("content-length");

      const headers: Record<string, string> = { "Content-Type": contentType };
      if (contentDisposition) headers["Content-Disposition"] = contentDisposition;
      if (contentLength) headers["Content-Length"] = contentLength;

      res.writeHead(upstream.status, headers);

      if (!upstream.body) {
        res.end();
        return;
      }

      // Stream the response body
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      };
      await pump();
    } catch (err) {
      error(`media proxy failed: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    }
  }

  // ── Start/Stop ──
  function start(): Promise<void> {
    return new Promise((resolve) => {
      server.listen(config.port, config.host, () => {
        log(`listening on ${config.host}:${config.port}`);
        log(`WebSocket endpoint: ws://${config.host}:${config.port}/ws`);
        log(`Webhook endpoint:   http://${config.host}:${config.port}/webhook`);
        log(`Media proxy:        http://${config.host}:${config.port}/media/proxy`);
        log(`Health check:       http://${config.host}:${config.port}/health`);
        for (const [aid, acfg] of Object.entries(config.accounts)) {
          log(`WeCom callback [${aid}]: http://${config.host}:${config.port}${acfg.webhookPath}`);
        }
        resolve();
      });
    });
  }

  function stop(): Promise<void> {
    clearInterval(pingInterval);
    for (const client of clients.values()) {
      client.ws.close(1000, "server shutdown");
    }
    return new Promise((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
      });
    });
  }

  return { start, stop, server, wss, clients, accountToClient, offlineBuffer };
}
