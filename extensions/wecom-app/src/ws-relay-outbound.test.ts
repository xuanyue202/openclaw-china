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

vi.mock("./ws-relay-client.js", () => ({
  isWsRelayOutboundActive: () => mockIsActive(),
  sendViaWsRelay: (params: unknown) => mockSendViaRelay(params),
  startWecomAppWsRelayClient: vi.fn(),
}));

// ── Mock global fetch to avoid real HTTP ──
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { sendWecomAppMessage, clearAllAccessTokenCache } from "./api.js";
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
