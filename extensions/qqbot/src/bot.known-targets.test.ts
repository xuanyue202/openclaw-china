import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQQBotRuntime, setQQBotRuntime } from "./runtime.js";

const outboundMocks = vi.hoisted(() => ({
  sendTyping: vi.fn(),
  sendText: vi.fn(),
  sendMedia: vi.fn(),
}));

const proactiveMocks = vi.hoisted(() => ({
  upsertKnownQQBotTarget: vi.fn(),
}));

vi.mock("./outbound.js", () => ({
  qqbotOutbound: {
    sendTyping: outboundMocks.sendTyping,
    sendText: outboundMocks.sendText,
    sendMedia: outboundMocks.sendMedia,
  },
}));

vi.mock("./proactive.js", () => ({
  upsertKnownQQBotTarget: proactiveMocks.upsertKnownQQBotTarget,
}));

import { handleQQBotDispatch } from "./bot.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const baseCfg = {
  channels: {
    qqbot: {
      enabled: true,
      appId: "app-1",
      clientSecret: "secret-1",
    },
  },
};

describe("QQBot inbound known-target recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundMocks.sendTyping.mockResolvedValue({ channel: "qqbot" });
    outboundMocks.sendText.mockResolvedValue({ channel: "qqbot", messageId: "m-1", timestamp: 1 });
    outboundMocks.sendMedia.mockResolvedValue({ channel: "qqbot", messageId: "m-2", timestamp: 2 });
    setQQBotRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            sessionKey: "session-1",
            accountId: "default",
            agentId: "main",
          }),
        },
        reply: {},
      },
    });
  });

  afterEach(() => {
    clearQQBotRuntime();
  });

  it("records canonical user targets for allowed C2C messages", async () => {
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-1",
        content: "hello",
        timestamp: 1700000000000,
        author: {
          user_openid: "u-123",
          username: "Alice",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).toHaveBeenCalledWith({
      target: {
        accountId: "default",
        kind: "user",
        target: "user:u-123",
        displayName: "Alice",
        sourceChatType: "direct",
        firstSeenAt: 1700000000000,
        lastSeenAt: 1700000000000,
      },
    });
  });

  it("records canonical group targets for allowed group messages", async () => {
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "GROUP_AT_MESSAGE_CREATE",
      eventData: {
        id: "msg-2",
        content: "hello group",
        timestamp: 1700000000100,
        group_openid: "g-456",
        author: {
          member_openid: "member-1",
          nickname: "Team Owner",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).toHaveBeenCalledWith({
      target: {
        accountId: "default",
        kind: "group",
        target: "group:g-456",
        displayName: "Team Owner",
        sourceChatType: "group",
        firstSeenAt: 1700000000100,
        lastSeenAt: 1700000000100,
      },
    });
  });

  it("records canonical channel targets for allowed channel messages", async () => {
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "AT_MESSAGE_CREATE",
      eventData: {
        id: "msg-3",
        content: "hello channel",
        timestamp: 1700000000200,
        channel_id: "channel-789",
        guild_id: "guild-1",
        author: {
          id: "author-1",
          username: "Channel Owner",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).toHaveBeenCalledWith({
      target: {
        accountId: "default",
        kind: "channel",
        target: "channel:channel-789",
        displayName: "Channel Owner",
        sourceChatType: "channel",
        firstSeenAt: 1700000000200,
        lastSeenAt: 1700000000200,
      },
    });
  });

  it("does not record targets when the inbound message is blocked by policy", async () => {
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-4",
        content: "blocked",
        timestamp: 1700000000300,
        author: {
          user_openid: "u-blocked",
          username: "Blocked User",
        },
      },
      cfg: {
        channels: {
          qqbot: {
            ...baseCfg.channels.qqbot,
            dmPolicy: "allowlist",
            allowFrom: ["u-allowed"],
          },
        },
      },
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).not.toHaveBeenCalled();
  });

  it("does not record DIRECT_MESSAGE_CREATE events into known targets", async () => {
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "DIRECT_MESSAGE_CREATE",
      eventData: {
        id: "msg-5",
        content: "dm hello",
        timestamp: 1700000000400,
        guild_id: "guild-2",
        author: {
          id: "dm-user-1",
          username: "DM User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).not.toHaveBeenCalled();
  });
});
