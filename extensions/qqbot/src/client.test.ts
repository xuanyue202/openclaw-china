import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  httpPost: vi.fn(),
  httpGet: vi.fn(),
}));

vi.mock("@openclaw-china/shared", async () => {
  const actual = await vi.importActual<typeof import("@openclaw-china/shared")>(
    "@openclaw-china/shared"
  );
  return {
    ...actual,
    httpPost: mocks.httpPost,
    httpGet: mocks.httpGet,
  };
});

import {
  MediaFileType,
  clearTokenCache,
  getAccessToken,
  sendChannelMessage,
  sendGroupMessage,
  uploadC2CMedia,
  uploadGroupMedia,
} from "./client.js";

describe("getAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
  });

  it("coerces numeric appId into string request payload", async () => {
    mocks.httpPost.mockResolvedValue({
      access_token: "token-1",
      expires_in: 7200,
    });

    const token = await getAccessToken(102824485, " secret ");

    expect(token).toBe("token-1");
    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://bots.qq.com/app/getAppAccessToken",
      { appId: "102824485", clientSecret: "secret" },
      { timeout: 15000 }
    );
  });

  it("rejects empty appId values after trimming", async () => {
    await expect(getAccessToken("  ", "secret")).rejects.toThrow("appId");
    expect(mocks.httpPost).not.toHaveBeenCalled();
  });

  it("includes file_name and srv_send_msg for FILE uploads", async () => {
    mocks.httpPost.mockResolvedValue({
      file_uuid: "file-1",
      file_info: "info-1",
      ttl: 3600,
    });

    await uploadC2CMedia({
      accessToken: "token-1",
      openid: "user-1",
      fileType: MediaFileType.FILE,
      fileData: "base64-data",
      fileName: "report.pdf",
    });

    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/v2/users/user-1/files",
      {
        file_type: 4,
        srv_send_msg: false,
        file_data: "base64-data",
        file_name: "report.pdf",
      },
      {
        timeout: 30000,
        headers: {
          Authorization: "QQBot token-1",
        },
      }
    );
  });

  it("sanitizes group file_name and includes srv_send_msg for FILE uploads", async () => {
    mocks.httpPost.mockResolvedValue({
      file_uuid: "file-2",
      file_info: "info-2",
      ttl: 3600,
    });

    await uploadGroupMedia({
      accessToken: "token-2",
      groupOpenid: "GroupABC123XYZ",
      fileType: MediaFileType.FILE,
      fileData: "group-base64-data",
      fileName: 'report<>:"/\\|?*.pdf',
    });

    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/v2/groups/GroupABC123XYZ/files",
      {
        file_type: 4,
        srv_send_msg: false,
        file_data: "group-base64-data",
        file_name: "report_________.pdf",
      },
      {
        timeout: 30000,
        headers: {
          Authorization: "QQBot token-2",
        },
      }
    );
  });

  it("preserves group_openid casing for group message sends", async () => {
    mocks.httpPost.mockResolvedValue({
      id: "msg-1",
      timestamp: 1,
    });

    await sendGroupMessage({
      accessToken: "token-1",
      groupOpenid: "GroupABC123XYZ",
      content: "hello",
      messageId: "msg-raw-1",
      markdown: false,
    });

    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/v2/groups/GroupABC123XYZ/messages",
      expect.objectContaining({
        content: "hello",
        msg_id: "msg-raw-1",
        msg_type: 0,
      }),
      expect.any(Object)
    );
  });

  it("preserves channel_id casing for channel message sends", async () => {
    mocks.httpPost.mockResolvedValue({
      id: "msg-2",
      timestamp: 2,
    });

    await sendChannelMessage({
      accessToken: "token-1",
      channelId: "ChannelABC123XYZ",
      content: "hello",
      messageId: "msg-raw-2",
    });

    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/channels/ChannelABC123XYZ/messages",
      expect.objectContaining({
        content: "hello",
        msg_id: "msg-raw-2",
      }),
      expect.any(Object)
    );
  });
});
