import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendWecomAppMessageMock } = vi.hoisted(() => ({
  sendWecomAppMessageMock: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    sendWecomAppMessage: sendWecomAppMessageMock,
    stripMarkdown: (text: string) => text,
  };
});

import { computeWecomAppMsgSignature, encryptWecomAppPlaintext } from "./crypto.js";
import { handleWecomAppWebhookRequest, registerWecomAppWebhookTarget, splitMessageByBytes } from "./monitor.js";
import { clearWecomAppRuntime, setWecomAppRuntime, type PluginRuntime } from "./runtime.js";
import { clearWecomTextSendQueues } from "./text-send-queue.js";
import { wecomAppPlugin } from "./channel.js";
import type { ResolvedWecomAppAccount } from "./types.js";

const token = "token123";
const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function createRequest(method: string, url: string, body?: string): IncomingMessage {
  const stream = new Readable({
    read() {
      return;
    },
  });
  if (body) {
    stream.push(body);
  }
  stream.push(null);
  (stream as IncomingMessage).method = method;
  (stream as IncomingMessage).url = url;
  return stream as IncomingMessage;
}

function createResponseRecorder() {
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    end: (data?: string | Buffer) => {
      if (data === undefined) return;
      chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    },
  } as unknown as ServerResponse;

  return {
    res,
    headers,
    getBody: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}

function buildAccount(): ResolvedWecomAppAccount {
  return {
    accountId: "app",
    enabled: true,
    configured: true,
    token,
    encodingAESKey,
    receiveId: "corp123",
    corpId: "corp-id",
    corpSecret: "secret",
    agentId: 1001,
    canSendActive: true,
    config: {
      webhookPath: "/wecom-app",
      agentId: 1001,
      dmPolicy: "open",
    },
  };
}

function buildRuntime(dispatchReplyWithBufferedBlockDispatcher: NonNullable<
  NonNullable<PluginRuntime["channel"]>["reply"]
>["dispatchReplyWithBufferedBlockDispatcher"]): PluginRuntime {
  return {
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          sessionKey: "session-1",
          accountId: "app",
        }),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  };
}

beforeEach(() => {
  clearWecomTextSendQueues();
  sendWecomAppMessageMock.mockReset();
  sendWecomAppMessageMock.mockResolvedValue({
    ok: true,
    errmsg: "ok",
    msgid: "out-1",
  });
});

afterEach(() => {
  clearWecomAppRuntime();
  vi.restoreAllMocks();
});

describe("splitMessageByBytes", () => {
  it("prefers Chinese sentence boundaries before hard cutting", () => {
    const text = "第一句中文。第二句中文。第三句中文。";
    const limit = Buffer.byteLength("第一句中文。第二句中文。", "utf8");

    expect(splitMessageByBytes(text, limit)).toEqual([
      "第一句中文。第二句中文。",
      "第三句中文。",
    ]);
  });

  it("prefers English sentence boundaries before hard cutting", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const limit = Buffer.byteLength("First sentence. Second sentence. ", "utf8");

    expect(splitMessageByBytes(text, limit)).toEqual([
      "First sentence. Second sentence. ",
      "Third sentence.",
    ]);
  });

  it("avoids cutting file paths in the middle when a line boundary is available", () => {
    const text = "请检查以下文件：\nidentity/device-auth.json\nidentity/device.json\nfeishu-user.json";
    const limit = Buffer.byteLength("请检查以下文件：\nidentity/device-auth.json\nidentity/device.j", "utf8");

    const chunks = splitMessageByBytes(text, limit);

    expect(chunks).toEqual([
      "请检查以下文件：\nidentity/device-auth.json\n",
      "identity/device.json\nfeishu-user.json",
    ]);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= limit)).toBe(true);
  });
});

describe("wecom-app active stream delivery", () => {
  it("accumulates chunks and sends consolidated content after stream finishes", async () => {
    const secondChunkGate = createDeferred();

    setWecomAppRuntime(buildRuntime(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "first verbose block" });
      await secondChunkGate.promise;
      await dispatcherOptions.deliver({ text: "second verbose block" });
    }));

    const unregister = registerWecomAppWebhookTarget({
      account: buildAccount(),
      config: { channels: { "wecom-app": {} } },
      runtime: {},
      path: "/wecom-app",
    });

    try {
      const message = {
        msgtype: "text",
        msgid: "m-stream-1",
        from: { userid: "user1" },
        text: { content: "hi" },
        AgentID: 1001,
      };

      const encrypt = encryptWecomAppPlaintext({
        encodingAESKey,
        receiveId: "corp123",
        plaintext: JSON.stringify(message),
      });

      const timestamp = "1700000010";
      const nonce = "nonce-stream-1";
      const signature = computeWecomAppMsgSignature({
        token,
        timestamp,
        nonce,
        encrypt,
      });

      const params = new URLSearchParams({
        timestamp,
        nonce,
        msg_signature: signature,
      });

      const req = createRequest("POST", `/wecom-app?${params.toString()}`, JSON.stringify({ encrypt }));
      const recorder = createResponseRecorder();

      const handled = await handleWecomAppWebhookRequest(req, recorder.res);

      expect(handled).toBe(true);
      expect(recorder.getBody()).toContain("\"encrypt\"");

      // 流式期间不发送，只累积
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sendWecomAppMessageMock).toHaveBeenCalledTimes(0);

      // 释放第二个 chunk，让流结束
      secondChunkGate.resolve();

      // markStreamFinished 后，完整内容被拆分后一次性发送
      await vi.waitFor(() => {
        expect(sendWecomAppMessageMock).toHaveBeenCalled();
      });
      expect(sendWecomAppMessageMock).toHaveBeenCalledTimes(1);
      expect(sendWecomAppMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "app" }),
        { userId: "user1" },
        "first verbose block\n\nsecond verbose block"
      );
    } finally {
      unregister();
    }
  });

  it("splits long accumulated content into 2048-byte chunks", async () => {
    // 生成超过 2048 字节的内容
    const longChunk1 = "A".repeat(1500);
    const longChunk2 = "B".repeat(1500);

    setWecomAppRuntime(buildRuntime(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: longChunk1 });
      await dispatcherOptions.deliver({ text: longChunk2 });
    }));

    const unregister = registerWecomAppWebhookTarget({
      account: buildAccount(),
      config: { channels: { "wecom-app": {} } },
      runtime: {},
      path: "/wecom-app",
    });

    try {
      const message = {
        msgtype: "text",
        msgid: "m-stream-2",
        from: { userid: "user1" },
        text: { content: "generate long" },
        AgentID: 1001,
      };

      const encrypt = encryptWecomAppPlaintext({
        encodingAESKey,
        receiveId: "corp123",
        plaintext: JSON.stringify(message),
      });

      const timestamp = "1700000020";
      const nonce = "nonce-stream-2";
      const signature = computeWecomAppMsgSignature({
        token,
        timestamp,
        nonce,
        encrypt,
      });

      const params = new URLSearchParams({
        timestamp,
        nonce,
        msg_signature: signature,
      });

      const req = createRequest("POST", `/wecom-app?${params.toString()}`, JSON.stringify({ encrypt }));
      const recorder = createResponseRecorder();

      await handleWecomAppWebhookRequest(req, recorder.res);

      // 等待 markStreamFinished 完成并发出全部分片
      await vi.waitFor(() => {
        expect(sendWecomAppMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      }, { timeout: 3000 });

      // 拼接所有发送的内容，应该等于完整累积内容
      const sentTexts = sendWecomAppMessageMock.mock.calls.map((call: unknown[]) => call[2] as string);
      const combined = sentTexts.join("");
      expect(combined).toBe(`${longChunk1}\n\n${longChunk2}`);
    } finally {
      unregister();
    }
  });

  it("serializes same-recipient sends across monitor and outbound channel paths", async () => {
    const firstChunkGate = createDeferred();
    let sendCallIndex = 0;

    sendWecomAppMessageMock.mockImplementation(async (_account, _target, text: string) => {
      sendCallIndex += 1;
      if (sendCallIndex === 1) {
        await firstChunkGate.promise;
      }
      return {
        ok: true,
        errmsg: "ok",
        msgid: `out-${sendCallIndex}`,
        text,
      };
    });

    const monitorMessage = "A".repeat(2200);
    const outboundMessage = "B".repeat(2200);

    setWecomAppRuntime(buildRuntime(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: monitorMessage });
    }));

    const unregister = registerWecomAppWebhookTarget({
      account: buildAccount(),
      config: { channels: { "wecom-app": {} } },
      runtime: {},
      path: "/wecom-app",
    });

    try {
      const message = {
        msgtype: "text",
        msgid: "m-stream-3",
        from: { userid: "user1" },
        text: { content: "hi" },
        AgentID: 1001,
      };

      const encrypt = encryptWecomAppPlaintext({
        encodingAESKey,
        receiveId: "corp123",
        plaintext: JSON.stringify(message),
      });

      const timestamp = "1700000030";
      const nonce = "nonce-stream-3";
      const signature = computeWecomAppMsgSignature({
        token,
        timestamp,
        nonce,
        encrypt,
      });

      const params = new URLSearchParams({
        timestamp,
        nonce,
        msg_signature: signature,
      });

      const req = createRequest("POST", `/wecom-app?${params.toString()}`, JSON.stringify({ encrypt }));
      const recorder = createResponseRecorder();

      const handled = await handleWecomAppWebhookRequest(req, recorder.res);
      expect(handled).toBe(true);

      await vi.waitFor(() => {
        expect(sendWecomAppMessageMock).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      const outboundSend = wecomAppPlugin.outbound.sendText({
        cfg: {
          channels: {
            "wecom-app": {
              accounts: {
                app: {
                  corpId: "corp-id",
                  corpSecret: "secret",
                  agentId: 1001,
                },
              },
            },
          },
        },
        to: "user:user1@app",
        text: outboundMessage,
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sendWecomAppMessageMock).toHaveBeenCalledTimes(1);

      firstChunkGate.resolve();
      await outboundSend;

      await vi.waitFor(() => {
        expect(sendWecomAppMessageMock).toHaveBeenCalledTimes(4);
      }, { timeout: 5000 });

      const sentTexts = sendWecomAppMessageMock.mock.calls.map((call: unknown[]) => call[2] as string);
      expect(sentTexts).toEqual([
        "A".repeat(2048),
        "A".repeat(152),
        "B".repeat(2048),
        "B".repeat(152),
      ]);
    } finally {
      unregister();
    }
  });
});
