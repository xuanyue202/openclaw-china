import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@openclaw-china/shared";
import {
  evaluateReplyFinalOnlyDelivery,
  isQQBotGroupMessageInterfaceBlocked,
  resolveQQBotNoReplyFallback,
  sanitizeQQBotOutboundText,
  sendQQBotMediaWithFallback,
  startLongTaskNoticeTimer,
} from "./bot.js";

describe("evaluateReplyFinalOnlyDelivery", () => {
  it("allows non-final tool payload when media exists, and suppresses text", () => {
    const decision = evaluateReplyFinalOnlyDelivery({
      replyFinalOnly: true,
      kind: "tool",
      hasMedia: true,
      sanitizedText: "语音说明",
    });
    expect(decision).toEqual({ skipDelivery: false, suppressText: true });
  });

  it("skips non-final text-only payload when replyFinalOnly is enabled", () => {
    const decision = evaluateReplyFinalOnlyDelivery({
      replyFinalOnly: true,
      kind: "tool",
      hasMedia: false,
      sanitizedText: "仅文本",
    });
    expect(decision).toEqual({ skipDelivery: true, suppressText: false });
  });

  it("keeps final event but strips NO_REPLY to empty outbound text", () => {
    const sanitized = sanitizeQQBotOutboundText("NO_REPLY");
    const decision = evaluateReplyFinalOnlyDelivery({
      replyFinalOnly: true,
      kind: "final",
      hasMedia: false,
      sanitizedText: sanitized,
    });
    const textToSend = decision.suppressText ? "" : sanitized;
    expect(decision.skipDelivery).toBe(false);
    expect(textToSend).toBe("");
  });

  it("does not suppress block text when replyFinalOnly is disabled", () => {
    const sanitized = sanitizeQQBotOutboundText("普通文本");
    const decision = evaluateReplyFinalOnlyDelivery({
      replyFinalOnly: false,
      kind: "block",
      hasMedia: false,
      sanitizedText: sanitized,
    });
    const textToSend = decision.suppressText ? "" : sanitized;
    expect(decision).toEqual({ skipDelivery: false, suppressText: false });
    expect(textToSend).toBe("普通文本");
  });
});

describe("sendQQBotMediaWithFallback", () => {
  it("falls back to text when remote media send fails", async () => {
    const sendMedia = vi.fn().mockResolvedValue({ channel: "qqbot", error: "upload failed" });
    const sendText = vi.fn().mockResolvedValue({ channel: "qqbot", messageId: "m1", timestamp: 1 });
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    await sendQQBotMediaWithFallback({
      qqCfg: {},
      to: "user:123",
      mediaQueue: ["https://example.com/a.mp3"],
      replyToId: "reply-1",
      logger,
      outbound: { sendMedia, sendText },
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0]?.text).toContain("https://example.com/a.mp3");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("sendMedia failed"));
  });

  it("does not echo local paths when local media send fails", async () => {
    const sendMedia = vi.fn().mockResolvedValue({ channel: "qqbot", error: "upload failed" });
    const sendText = vi.fn().mockResolvedValue({ channel: "qqbot", messageId: "m1", timestamp: 1 });
    const onDelivered = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    await sendQQBotMediaWithFallback({
      qqCfg: {},
      to: "user:123",
      mediaQueue: ["C:\\Users\\Administrator\\.openclaw\\workspace\\converted-image.pdf"],
      replyToId: "reply-1",
      logger,
      onDelivered,
      outbound: { sendMedia, sendText },
    });

    expect(sendText).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();
  });
});

describe("resolveQQBotNoReplyFallback", () => {
  it("returns fallback text for mentioned group messages when nothing was delivered", () => {
    const fallback = resolveQQBotNoReplyFallback({
      inbound: {
        type: "group",
        mentionedBot: true,
        content: "1",
        attachments: undefined,
      },
      replyDelivered: false,
    });

    expect(fallback).toBe("我在。你可以直接说具体一点。");
  });

  it("does not return fallback once a visible reply was delivered", () => {
    const fallback = resolveQQBotNoReplyFallback({
      inbound: {
        type: "group",
        mentionedBot: true,
        content: "1",
        attachments: undefined,
      },
      replyDelivered: true,
    });

    expect(fallback).toBeUndefined();
  });

  it("does not return fallback for direct messages", () => {
    const fallback = resolveQQBotNoReplyFallback({
      inbound: {
        type: "direct",
        mentionedBot: false,
        content: "1",
        attachments: undefined,
      },
      replyDelivered: false,
    });

    expect(fallback).toBeUndefined();
  });
});

describe("isQQBotGroupMessageInterfaceBlocked", () => {
  it("detects platform temporary ban errors", () => {
    expect(
      isQQBotGroupMessageInterfaceBlocked(
        'HTTP 500: Internal Server Error - {"message":"机器人存在安全风险，群内消息接口被临时封禁","code":304103}'
      )
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isQQBotGroupMessageInterfaceBlocked("HTTP 500: Internal Server Error")).toBe(false);
  });
});

describe("startLongTaskNoticeTimer", () => {
  it("sends notice after configured delay", async () => {
    vi.useFakeTimers();
    const sendNotice = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() } as unknown as Logger;

    startLongTaskNoticeTimer({
      delayMs: 30000,
      logger,
      sendNotice,
    });

    await vi.advanceTimersByTimeAsync(29999);
    expect(sendNotice).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendNotice).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("cancels notice once a real reply is delivered", async () => {
    vi.useFakeTimers();
    const sendNotice = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() } as unknown as Logger;

    const timer = startLongTaskNoticeTimer({
      delayMs: 30000,
      logger,
      sendNotice,
    });

    await vi.advanceTimersByTimeAsync(10000);
    timer.markReplyDelivered();
    await vi.advanceTimersByTimeAsync(20000);

    expect(sendNotice).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("treats zero delay as disabled", async () => {
    vi.useFakeTimers();
    const sendNotice = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() } as unknown as Logger;

    startLongTaskNoticeTimer({
      delayMs: 0,
      logger,
      sendNotice,
    });

    await vi.advanceTimersByTimeAsync(60000);
    expect(sendNotice).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
