import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@openclaw-china/shared";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  sendC2CInputNotify: vi.fn(),
  sendC2CMessage: vi.fn(),
  sendGroupMessage: vi.fn(),
  sendChannelMessage: vi.fn(),
  sendFileQQBot: vi.fn(),
}));

vi.mock("./client.js", () => ({
  getAccessToken: mocks.getAccessToken,
  sendC2CInputNotify: mocks.sendC2CInputNotify,
  sendC2CMessage: mocks.sendC2CMessage,
  sendGroupMessage: mocks.sendGroupMessage,
  sendChannelMessage: mocks.sendChannelMessage,
}));

vi.mock("./send.js", () => ({
  sendFileQQBot: mocks.sendFileQQBot,
}));

import { qqbotOutbound } from "./outbound.js";

const baseCfg = {
  channels: {
    qqbot: {
      appId: "app-1",
      clientSecret: "secret-1",
      markdownSupport: true,
    },
  },
};

describe("qqbotOutbound event_id fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccessToken.mockResolvedValue("token-1");
  });

  it("forces plain text for group messages even when markdown support is enabled", async () => {
    mocks.sendGroupMessage.mockResolvedValueOnce({ id: "group-text-1", timestamp: 1 });

    const result = await qqbotOutbound.sendText({
      cfg: baseCfg,
      to: "group:g-plain",
      text: "hello group",
      replyToId: "msg-plain-1",
    });

    expect(result).toEqual({ channel: "qqbot", messageId: "group-text-1", timestamp: 1 });
    expect(mocks.sendGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        groupOpenid: "g-plain",
        content: "hello group",
        messageId: "msg-plain-1",
        markdown: false,
      })
    );
  });

  it("retries group text with event_id when msg_id is expired", async () => {
    mocks.sendGroupMessage
      .mockRejectedValueOnce(
        new HttpError(
          "HTTP 400: Bad Request",
          400,
          JSON.stringify({ code: 40034025, message: "msg_id 过期" })
        )
      )
      .mockResolvedValueOnce({ id: "ok-1", timestamp: 1 });

    const result = await qqbotOutbound.sendText({
      cfg: baseCfg,
      to: "group:g-1",
      text: "hello",
      replyToId: "msg-1",
      replyEventId: "evt-1",
    });

    expect(result).toEqual({ channel: "qqbot", messageId: "ok-1", timestamp: 1 });
    expect(mocks.sendGroupMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendGroupMessage.mock.calls[0]?.[0]).toMatchObject({
      messageId: "msg-1",
      markdown: false,
    });
    expect(mocks.sendGroupMessage.mock.calls[1]?.[0]).toMatchObject({
      eventId: "evt-1",
      markdown: false,
    });
  });

  it("does not retry text when event_id is missing", async () => {
    mocks.sendGroupMessage.mockRejectedValueOnce(
      new HttpError(
        "HTTP 400: Bad Request",
        400,
        JSON.stringify({ code: 40034025, message: "msg_id expired" })
      )
    );

    const result = await qqbotOutbound.sendText({
      cfg: baseCfg,
      to: "group:g-1",
      text: "hello",
      replyToId: "msg-1",
    });

    expect(result.channel).toBe("qqbot");
    expect(result.error).toContain("HTTP 400");
    expect(result.error).toContain("msg_id expired");
    expect(mocks.sendGroupMessage).toHaveBeenCalledTimes(1);
  });

  it("retries media send with event_id when msg_id is expired", async () => {
    mocks.sendFileQQBot
      .mockRejectedValueOnce(new Error("QQBot group media send failed: code=40034025, message=msg_id 失效"))
      .mockResolvedValueOnce({ id: "media-1", timestamp: 2 });

    const result = await qqbotOutbound.sendMedia({
      cfg: baseCfg,
      to: "group:g-2",
      text: "caption",
      mediaUrl: "https://example.com/a.png",
      replyToId: "msg-2",
      replyEventId: "evt-2",
    });

    expect(result).toEqual({ channel: "qqbot", messageId: "media-1", timestamp: 2 });
    expect(mocks.sendFileQQBot).toHaveBeenCalledTimes(2);
    expect(mocks.sendFileQQBot.mock.calls[0]?.[0]).toMatchObject({ messageId: "msg-2", text: "caption" });
    expect(mocks.sendFileQQBot.mock.calls[1]?.[0]).toMatchObject({ eventId: "evt-2", text: "caption" });
  });

  it("sends follow-up text after generic file delivery", async () => {
    mocks.sendFileQQBot.mockResolvedValueOnce({ id: "media-2", timestamp: 3 });
    mocks.sendC2CMessage.mockResolvedValueOnce({ id: "text-1", timestamp: 4 });

    const result = await qqbotOutbound.sendMedia({
      cfg: baseCfg,
      to: "user:u-1",
      text: "给你转好了~",
      mediaUrl: "C:/tmp/report.pdf",
      replyToId: "msg-3",
    });

    expect(result).toEqual({ channel: "qqbot", messageId: "media-2", timestamp: 3 });
    expect(mocks.sendFileQQBot).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "C:/tmp/report.pdf",
        text: undefined,
        messageId: "msg-3",
      })
    );
    expect(mocks.sendC2CMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        openid: "u-1",
        content: "给你转好了~",
        messageId: "msg-3",
      })
    );
  });
});
