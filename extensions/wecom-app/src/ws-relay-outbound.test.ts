/**
 * ws-relay 出站消息路由测试
 *
 * 验证：
 * - isWsRelayOutboundActive / sendViaWsRelay 模块级状态
 * - sendWecomAppMessage 在 ws-relay 模式下走 relay
 * - sendWecomAppMessage 在非 ws-relay 模式下直接调 API
 * - relay 不可用时 fallback 到直接 API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock ws-relay-client exports ──
const mockIsActive = vi.fn().mockReturnValue(false);
const mockSendViaRelay = vi.fn().mockResolvedValue(null);
const mockGetMediaProxy = vi.fn().mockReturnValue(null);

vi.mock("./ws-relay-client.js", () => ({
  isWsRelayOutboundActive: () => mockIsActive(),
  sendViaWsRelay: (params: unknown) => mockSendViaRelay(params),
  getWsRelayMediaProxy: () => mockGetMediaProxy(),
  startWecomAppWsRelayClient: vi.fn(),
}));

// ── Mock global fetch to avoid real HTTP ──
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { sendWecomAppMessage, clearAllAccessTokenCache, downloadWecomMediaToFile } from "./api.js";
import type { ResolvedWecomAppAccount } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeAccount(mode: "webhook" | "ws-relay" = "webhook"): ResolvedWecomAppAccount {
  return {
    accountId: "test",
    enabled: true,
    configured: true,
    mode,
    token: "tok",
    encodingAESKey: "key",
    receiveId: "corp1",
    corpId: "corp1",
    corpSecret: "secret1",
    agentId: 1000001,
    canSendActive: true,
    config: {
      dmPolicy: "open",
    } as ResolvedWecomAppAccount["config"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("ws-relay outbound routing", () => {
  beforeEach(() => {
    mockIsActive.mockReturnValue(false);
    mockSendViaRelay.mockResolvedValue(null);
    mockGetMediaProxy.mockReturnValue(null);
    mockFetch.mockReset();
    clearAllAccessTokenCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes through relay when mode=ws-relay and relay is active", async () => {
    mockIsActive.mockReturnValue(true);
    mockSendViaRelay.mockResolvedValue({ ok: true, errcode: 0, errmsg: "ok" });

    const account = makeAccount("ws-relay");
    const result = await sendWecomAppMessage(account, { userId: "Alice" }, "hello");

    expect(result.ok).toBe(true);
    expect(result.errcode).toBe(0);

    // Should have called relay, NOT fetch
    expect(mockSendViaRelay).toHaveBeenCalledTimes(1);
    expect(mockSendViaRelay).toHaveBeenCalledWith({
      channelId: "Alice",
      text: "hello",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to direct API when relay returns null", async () => {
    mockIsActive.mockReturnValue(true);
    mockSendViaRelay.mockResolvedValue(null); // relay not available

    // Mock the getAccessToken + send fetch calls
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "at_123", errcode: 0 }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ errcode: 0, errmsg: "ok", msgid: "m1" }),
      });

    const account = makeAccount("ws-relay");
    const result = await sendWecomAppMessage(account, { userId: "Bob" }, "fallback msg");

    expect(result.ok).toBe(true);
    expect(mockSendViaRelay).toHaveBeenCalledTimes(1);
    // Should have called fetch for getAccessToken + message/send
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("uses direct API in webhook mode (no relay attempt)", async () => {
    mockIsActive.mockReturnValue(true); // relay active, but mode is webhook

    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "at_456", errcode: 0 }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ errcode: 0, errmsg: "ok", msgid: "m2" }),
      });

    const account = makeAccount("webhook");
    const result = await sendWecomAppMessage(account, { userId: "Charlie" }, "direct msg");

    expect(result.ok).toBe(true);
    // Should NOT have called relay
    expect(mockSendViaRelay).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("uses direct API when relay is not active", async () => {
    mockIsActive.mockReturnValue(false);

    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "at_789", errcode: 0 }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ errcode: 0, errmsg: "ok" }),
      });

    const account = makeAccount("ws-relay");
    const result = await sendWecomAppMessage(account, { userId: "Dave" }, "no relay");

    expect(result.ok).toBe(true);
    expect(mockSendViaRelay).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("propagates relay error result", async () => {
    mockIsActive.mockReturnValue(true);
    mockSendViaRelay.mockResolvedValue({ ok: false, errcode: 60011, errmsg: "ip not allowed" });

    const account = makeAccount("ws-relay");
    const result = await sendWecomAppMessage(account, { userId: "Eve" }, "error msg");

    expect(result.ok).toBe(false);
    expect(result.errcode).toBe(60011);
    expect(result.errmsg).toBe("ip not allowed");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns error when canSendActive is false", async () => {
    const account = makeAccount("ws-relay");
    account.canSendActive = false;

    const result = await sendWecomAppMessage(account, { userId: "Fay" }, "nope");

    expect(result.ok).toBe(false);
    expect(result.errcode).toBe(-1);
    expect(mockSendViaRelay).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("ws-relay media download proxy", () => {
  beforeEach(() => {
    mockIsActive.mockReturnValue(false);
    mockSendViaRelay.mockResolvedValue(null);
    mockGetMediaProxy.mockReturnValue(null);
    mockFetch.mockReset();
    clearAllAccessTokenCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeMediaAccount(mode: "webhook" | "ws-relay" = "ws-relay"): ResolvedWecomAppAccount {
    return {
      accountId: "test",
      enabled: true,
      configured: true,
      mode,
      token: "tok",
      encodingAESKey: "key",
      receiveId: "corp1",
      corpId: "corp1",
      corpSecret: "secret1",
      agentId: 1000001,
      canSendActive: true,
      config: {
        dmPolicy: "open",
      } as ResolvedWecomAppAccount["config"],
    };
  }

  function mockStreamResponse(content: Buffer | string, headers: Record<string, string> = {}) {
    const buf = typeof content === "string" ? Buffer.from(content) : content;
    return {
      ok: true,
      status: 200,
      headers: new Map(Object.entries({
        "content-type": "image/png",
        ...headers,
      })),
      body: {
        getReader: () => {
          let read = false;
          return {
            read: async () => {
              if (!read) { read = true; return { done: false, value: new Uint8Array(buf) }; }
              return { done: true, value: undefined };
            },
            cancel: vi.fn(),
          };
        },
      },
    };
  }

  it("routes media download through relay proxy in ws-relay mode", async () => {
    const account = makeMediaAccount("ws-relay");
    mockGetMediaProxy.mockReturnValue({
      baseUrl: "http://relay.local:9080",
      sessionId: "sess_abc",
      insecure: false,
    });

    // First call: getAccessToken; Second call: media proxy
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "at_media", errcode: 0 }),
      })
      .mockResolvedValueOnce(mockStreamResponse("image-data"));

    const result = await downloadWecomMediaToFile(account, "media_id_123", {
      maxBytes: 10 * 1024 * 1024,
    });

    expect(result.ok).toBe(true);

    // Verify: first call is getAccessToken (direct to WeCom), second is media proxy
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const mediaUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(mediaUrl).toContain("http://relay.local:9080/media/proxy");
    expect(mediaUrl).toContain("media_id=media_id_123");
    expect(mediaUrl).toContain("access_token=at_media");

    // Verify X-Session-ID header
    const fetchOpts = mockFetch.mock.calls[1]?.[1] as { headers?: Record<string, string> };
    expect(fetchOpts?.headers?.["X-Session-ID"]).toBe("sess_abc");

    // Cleanup temp file
    if (result.ok && result.path) {
      const { unlink } = await import("node:fs/promises");
      await unlink(result.path).catch(() => {});
    }
  });

  it("downloads directly from WeCom when not in ws-relay mode", async () => {
    const account = makeMediaAccount("webhook");
    // Even if media proxy is somehow set, should not use it in webhook mode
    mockGetMediaProxy.mockReturnValue({
      baseUrl: "http://relay.local:9080",
      sessionId: "sess_abc",
      insecure: false,
    });

    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "at_direct", errcode: 0 }),
      })
      .mockResolvedValueOnce(mockStreamResponse("direct-image-data"));

    const result = await downloadWecomMediaToFile(account, "media_id_456", {
      maxBytes: 10 * 1024 * 1024,
    });

    expect(result.ok).toBe(true);

    // Verify: media download goes directly to WeCom API
    const mediaUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(mediaUrl).toContain("qyapi.weixin.qq.com/cgi-bin/media/get");
    expect(mediaUrl).not.toContain("relay.local");

    if (result.ok && result.path) {
      const { unlink } = await import("node:fs/promises");
      await unlink(result.path).catch(() => {});
    }
  });

  it("uses insecureFetch for relay proxy with insecure=true and https URL", async () => {
    const account = makeMediaAccount("ws-relay");
    // Use 127.0.0.1 to get fast ECONNREFUSED instead of DNS timeout
    mockGetMediaProxy.mockReturnValue({
      baseUrl: "https://127.0.0.1:19999",
      sessionId: "sess_insecure",
      insecure: true,
    });

    // First call: getAccessToken (goes through mockFetch)
    // Second call: media proxy (goes through insecureFetch → https.request, NOT mockFetch)
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "at_insecure", errcode: 0 }),
      });

    // insecureFetch uses https.request which will fail with ECONNREFUSED
    try {
      await downloadWecomMediaToFile(account, "media_id_insecure", {
        maxBytes: 10 * 1024 * 1024,
      });
      // Should not reach here
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(String(err)).toMatch(/ECONNREFUSED/i);
    }

    // Key assertion: mockFetch was called only once (for getAccessToken).
    // The media download went through insecureFetch (https.request), not global fetch.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const tokenUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(tokenUrl).toContain("gettoken");
  });

  it("uses standard fetch for relay proxy with insecure=true but http URL", async () => {
    const account = makeMediaAccount("ws-relay");
    mockGetMediaProxy.mockReturnValue({
      baseUrl: "http://relay.local:9080",
      sessionId: "sess_http",
      insecure: true, // insecure flag set but URL is http, should use normal fetch
    });

    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "at_http", errcode: 0 }),
      })
      .mockResolvedValueOnce(mockStreamResponse("http-data"));

    const result = await downloadWecomMediaToFile(account, "media_id_http", {
      maxBytes: 10 * 1024 * 1024,
    });

    expect(result.ok).toBe(true);

    // Both calls (getAccessToken + media) go through global fetch since URL is http
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const mediaUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(mediaUrl).toContain("http://relay.local:9080/media/proxy");

    if (result.ok && result.path) {
      const { unlink } = await import("node:fs/promises");
      await unlink(result.path).catch(() => {});
    }
  });

  it("uses standard fetch for relay proxy with insecure=false and https URL", async () => {
    const account = makeMediaAccount("ws-relay");
    mockGetMediaProxy.mockReturnValue({
      baseUrl: "https://relay.local:9080",
      sessionId: "sess_secure",
      insecure: false,
    });

    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "at_secure", errcode: 0 }),
      })
      .mockResolvedValueOnce(mockStreamResponse("secure-data"));

    const result = await downloadWecomMediaToFile(account, "media_id_secure", {
      maxBytes: 10 * 1024 * 1024,
    });

    expect(result.ok).toBe(true);

    // Both calls go through global fetch (insecure=false)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const mediaUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(mediaUrl).toContain("https://relay.local:9080/media/proxy");

    if (result.ok && result.path) {
      const { unlink } = await import("node:fs/promises");
      await unlink(result.path).catch(() => {});
    }
  });

  it("downloads directly when relay proxy is not active", async () => {
    const account = makeMediaAccount("ws-relay");
    mockGetMediaProxy.mockReturnValue(null); // relay not connected

    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "at_fallback", errcode: 0 }),
      })
      .mockResolvedValueOnce(mockStreamResponse("fallback-data"));

    const result = await downloadWecomMediaToFile(account, "media_id_789", {
      maxBytes: 10 * 1024 * 1024,
    });

    expect(result.ok).toBe(true);

    // Should go directly to WeCom API (no relay)
    const mediaUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(mediaUrl).toContain("qyapi.weixin.qq.com/cgi-bin/media/get");

    if (result.ok && result.path) {
      const { unlink } = await import("node:fs/promises");
      await unlink(result.path).catch(() => {});
    }
  });
});
