import { afterEach, describe, expect, it, vi } from "vitest";

import { sendTextMessage } from "./wecom-api.js";

function createAccount(overrides?: { corpId?: string; agentId?: number }) {
  return {
    corpId: overrides?.corpId ?? "corp-id",
    corpSecret: "corp-secret",
    agentId: overrides?.agentId ?? 1000001,
    apiBaseUrl: "https://qyapi.weixin.qq.com",
    token: "token",
    encodingAESKey: "encoding-aes-key",
    receiveId: "corp-id",
    webhookPath: "/wecom",
  };
}

function mockJsonResponse(payload: unknown): Response {
  return {
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("wecom-app-relay sendTextMessage", () => {
  it("serializes same-recipient sends", async () => {
    const firstSendGate = createDeferred();
    const sentBodies: Array<{ touser?: string; text?: { content?: string } }> = [];

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockJsonResponse({ errcode: 0, access_token: "token-a" }))
      .mockImplementationOnce(async (_url, init) => {
        sentBodies.push(JSON.parse(String(init?.body)) as { touser?: string; text?: { content?: string } });
        await firstSendGate.promise;
        return mockJsonResponse({ errcode: 0, errmsg: "ok" });
      })
      .mockImplementationOnce(async (_url, init) => {
        sentBodies.push(JSON.parse(String(init?.body)) as { touser?: string; text?: { content?: string } });
        return mockJsonResponse({ errcode: 0, errmsg: "ok" });
      });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const account = createAccount({ corpId: "corp-same", agentId: 1001 });
    const firstSend = sendTextMessage(account, "alice", "first");

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const secondSend = sendTextMessage(account, "alice", "second");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    firstSendGate.resolve();
    await Promise.all([firstSend, secondSend]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentBodies).toEqual([
      expect.objectContaining({ touser: "alice", text: { content: "first" } }),
      expect.objectContaining({ touser: "alice", text: { content: "second" } }),
    ]);
  });

  it("does not block different recipients", async () => {
    const firstSendGate = createDeferred();
    const sentBodies: Array<{ touser?: string; text?: { content?: string } }> = [];

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockJsonResponse({ errcode: 0, access_token: "token-b" }))
      .mockImplementationOnce(async (_url, init) => {
        sentBodies.push(JSON.parse(String(init?.body)) as { touser?: string; text?: { content?: string } });
        await firstSendGate.promise;
        return mockJsonResponse({ errcode: 0, errmsg: "ok" });
      })
      .mockImplementationOnce(async (_url, init) => {
        sentBodies.push(JSON.parse(String(init?.body)) as { touser?: string; text?: { content?: string } });
        return mockJsonResponse({ errcode: 0, errmsg: "ok" });
      });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const account = createAccount({ corpId: "corp-diff", agentId: 1002 });
    const firstSend = sendTextMessage(account, "alice", "first");

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const secondSend = sendTextMessage(account, "bob", "second");

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    firstSendGate.resolve();
    await Promise.all([firstSend, secondSend]);

    expect(sentBodies).toEqual([
      expect.objectContaining({ touser: "alice", text: { content: "first" } }),
      expect.objectContaining({ touser: "bob", text: { content: "second" } }),
    ]);
  });
});
