/**
 * QQ Bot 出站适配器
 */

import { detectMediaType, HttpError, stripTitleFromUrl } from "@openclaw-china/shared";
import {
  mergeQQBotAccountConfig,
  resolveQQBotCredentials,
  DEFAULT_ACCOUNT_ID,
  type PluginConfig,
} from "./config.js";
import {
  getAccessToken,
  sendC2CInputNotify,
  sendC2CMessage,
  sendGroupMessage,
  sendChannelMessage,
} from "./client.js";
import { sendFileQQBot } from "./send.js";
import type { QQBotSendResult } from "./types.js";


type TargetKind = "c2c" | "group" | "channel";

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function parseTarget(to: string): { kind: TargetKind; id: string } {
  let raw = to.trim();
  raw = stripPrefix(raw, "qqbot:");

  if (raw.startsWith("group:")) {
    return { kind: "group", id: raw.slice("group:".length) };
  }
  if (raw.startsWith("channel:")) {
    return { kind: "channel", id: raw.slice("channel:".length) };
  }
  if (raw.startsWith("user:")) {
    return { kind: "c2c", id: raw.slice("user:".length) };
  }
  if (raw.startsWith("c2c:")) {
    return { kind: "c2c", id: raw.slice("c2c:".length) };
  }

  return { kind: "c2c", id: raw };
}

function shortId(value?: string): string {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function summarizeError(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body?.trim();
    return body ? `${err.message} - ${body}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function logEventIdFallback(params: {
  phase: "start" | "success" | "failed";
  action: "text" | "media" | "typing";
  accountId?: string;
  targetKind: TargetKind;
  targetId: string;
  messageId?: string;
  eventId?: string;
  reason?: string;
}): void {
  const accountLabel = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const detail =
    `[qqbot] event_id-fallback phase=${params.phase} action=${params.action} accountId=${accountLabel} ` +
    `target=${params.targetKind}:${shortId(params.targetId)} msg_id=${shortId(params.messageId)} event_id=${shortId(params.eventId)}` +
    (params.reason ? ` reason=${params.reason}` : "");

  if (params.phase === "failed") {
    console.error(detail);
    return;
  }
  if (params.phase === "start") {
    console.warn(detail);
    return;
  }
  console.info(detail);
}

function shouldRetryWithEventId(err: unknown): boolean {
  const status = err instanceof HttpError ? err.status : undefined;
  let body = "";
  if (err instanceof HttpError) {
    body = err.body ?? "";
  } else if (err instanceof Error) {
    body = err.message;
  } else {
    body = String(err);
  }

  const text = body.toLowerCase();
  const mentionsPassiveReply =
    text.includes("msg_id") ||
    text.includes("被动") ||
    text.includes("passive") ||
    text.includes("reply");
  if (!mentionsPassiveReply && !(typeof status === "number" && status >= 400 && status < 500)) {
    return false;
  }

  return (
    text.includes("expire") ||
    text.includes("invalid") ||
    text.includes("not found") ||
    text.includes("超过") ||
    text.includes("超时") ||
    text.includes("过期") ||
    text.includes("失效") ||
    text.includes("无效")
  );
}

function shouldSendTextAsFollowupForMedia(mediaUrl: string): boolean {
  return detectMediaType(stripTitleFromUrl(mediaUrl)) === "file";
}

export const qqbotOutbound = {
  deliveryMode: "direct" as const,
  textChunkLimit: 1500,
  chunkerMode: "markdown" as const,

  sendText: async (params: {
    cfg: PluginConfig;
    to: string;
    text: string;
    replyToId?: string;
    replyEventId?: string;
    accountId?: string;
  }): Promise<QQBotSendResult> => {
    const { cfg, to, text, replyToId, replyEventId, accountId } = params;
    const qqCfg = mergeQQBotAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
    const credentials = resolveQQBotCredentials(qqCfg);
    if (!credentials) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId/clientSecret)" };
    }

    const target = parseTarget(to);
    const accessToken = await getAccessToken(credentials.appId, credentials.clientSecret);
    const markdown = qqCfg.markdownSupport ?? true;
    const groupMarkdown = false;

    try {
      if (target.kind === "group") {
        let result: { id: string; timestamp: number | string };
        try {
          result = await sendGroupMessage({
            accessToken,
            groupOpenid: target.id,
            content: text,
            messageId: replyToId,
            markdown: groupMarkdown,
          });
        } catch (err) {
          if (!replyToId || !replyEventId || !shouldRetryWithEventId(err)) {
            throw err;
          }
          logEventIdFallback({
            phase: "start",
            action: "text",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
            reason: summarizeError(err),
          });
          try {
          result = await sendGroupMessage({
            accessToken,
            groupOpenid: target.id,
            content: text,
            eventId: replyEventId,
            markdown: groupMarkdown,
          });
            logEventIdFallback({
              phase: "success",
              action: "text",
              accountId,
              targetKind: target.kind,
              targetId: target.id,
              messageId: replyToId,
              eventId: replyEventId,
            });
          } catch (retryErr) {
            logEventIdFallback({
              phase: "failed",
              action: "text",
              accountId,
              targetKind: target.kind,
              targetId: target.id,
              messageId: replyToId,
              eventId: replyEventId,
              reason: summarizeError(retryErr),
            });
            throw retryErr;
          }
        }
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      }
      if (target.kind === "channel") {
        const result = await sendChannelMessage({
          accessToken,
          channelId: target.id,
          content: text,
          messageId: replyToId,
        });
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      }

      let result: { id: string; timestamp: number | string };
      try {
        result = await sendC2CMessage({
          accessToken,
          openid: target.id,
          content: text,
          messageId: replyToId,
          markdown,
        });
      } catch (err) {
        if (!replyToId || !replyEventId || !shouldRetryWithEventId(err)) {
          throw err;
        }
        logEventIdFallback({
          phase: "start",
          action: "text",
          accountId,
          targetKind: target.kind,
          targetId: target.id,
          messageId: replyToId,
          eventId: replyEventId,
          reason: summarizeError(err),
        });
        try {
        result = await sendC2CMessage({
          accessToken,
          openid: target.id,
          content: text,
          eventId: replyEventId,
          markdown,
        });
          logEventIdFallback({
            phase: "success",
            action: "text",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
          });
        } catch (retryErr) {
          logEventIdFallback({
            phase: "failed",
            action: "text",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
            reason: summarizeError(retryErr),
          });
          throw retryErr;
        }
      }
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } catch (err) {
      const message = summarizeError(err);
      return { channel: "qqbot", error: message };
    }
  },

  sendMedia: async (params: {
    cfg: PluginConfig;
    to: string;
    text?: string;
    mediaUrl?: string;
    replyToId?: string;
    replyEventId?: string;
    accountId?: string;
  }): Promise<QQBotSendResult> => {
    const { cfg, to, mediaUrl, text, replyToId, replyEventId, accountId } = params;
    if (!mediaUrl) {
      const fallbackText = text?.trim() ?? "";
      if (!fallbackText) {
        return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
      }
      return qqbotOutbound.sendText({ cfg, to, text: fallbackText, replyToId, replyEventId, accountId });
    }

    const qqCfg = mergeQQBotAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
    if (!resolveQQBotCredentials(qqCfg)) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId/clientSecret)" };
    }

    const target = parseTarget(to);
    const trimmedText = text?.trim() ? text.trim() : undefined;
    const sendTextAsFollowup = trimmedText ? shouldSendTextAsFollowupForMedia(mediaUrl) : false;
    if (target.kind === "channel") {
      const fallbackText = trimmedText ? `${trimmedText}\n${mediaUrl}` : mediaUrl;
      return qqbotOutbound.sendText({ cfg, to, text: fallbackText, replyToId, replyEventId, accountId });
    }

    try {
      let result: { id: string; timestamp: number | string };
      try {
        result = await sendFileQQBot({
          cfg: qqCfg,
          target: { kind: target.kind, id: target.id },
          mediaUrl,
          text: sendTextAsFollowup ? undefined : trimmedText,
          messageId: replyToId,
        });
      } catch (err) {
        if (!replyToId || !replyEventId || !shouldRetryWithEventId(err)) {
          throw err;
        }
        logEventIdFallback({
          phase: "start",
          action: "media",
          accountId,
          targetKind: target.kind,
          targetId: target.id,
          messageId: replyToId,
          eventId: replyEventId,
          reason: summarizeError(err),
        });
        try {
        result = await sendFileQQBot({
          cfg: qqCfg,
          target: { kind: target.kind, id: target.id },
          mediaUrl,
          text: sendTextAsFollowup ? undefined : trimmedText,
          eventId: replyEventId,
        });
          logEventIdFallback({
            phase: "success",
            action: "media",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
          });
        } catch (retryErr) {
          logEventIdFallback({
            phase: "failed",
            action: "media",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
            reason: summarizeError(retryErr),
          });
          throw retryErr;
        }
      }
      if (sendTextAsFollowup && trimmedText) {
        const textResult = await qqbotOutbound.sendText({
          cfg,
          to,
          text: trimmedText,
          replyToId,
          replyEventId,
          accountId,
        });
        if (textResult.error) {
          return {
            channel: "qqbot",
            error: `QQBot follow-up text send failed after media delivery: ${textResult.error}`,
          };
        }
      }
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } catch (err) {
      const message = summarizeError(err);
      return { channel: "qqbot", error: message };
    }
  },

  sendTyping: async (params: {
    cfg: PluginConfig;
    to: string;
    replyToId?: string;
    replyEventId?: string;
    inputSecond?: number;
    accountId?: string;
  }): Promise<QQBotSendResult> => {
    const { cfg, to, replyToId, replyEventId, inputSecond, accountId } = params;
    const qqCfg = mergeQQBotAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
    const credentials = resolveQQBotCredentials(qqCfg);
    if (!credentials) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId/clientSecret)" };
    }

    const target = parseTarget(to);
    if (target.kind !== "c2c") {
      return { channel: "qqbot" };
    }

    try {
      const accessToken = await getAccessToken(credentials.appId, credentials.clientSecret);
      try {
        await sendC2CInputNotify({
          accessToken,
          openid: target.id,
          messageId: replyToId,
          eventId: !replyToId ? replyEventId : undefined,
          inputSecond,
        });
      } catch (err) {
        if (!replyToId || !replyEventId || !shouldRetryWithEventId(err)) {
          throw err;
        }
        logEventIdFallback({
          phase: "start",
          action: "typing",
          accountId,
          targetKind: target.kind,
          targetId: target.id,
          messageId: replyToId,
          eventId: replyEventId,
          reason: summarizeError(err),
        });
        try {
        await sendC2CInputNotify({
          accessToken,
          openid: target.id,
          eventId: replyEventId,
          inputSecond,
        });
          logEventIdFallback({
            phase: "success",
            action: "typing",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
          });
        } catch (retryErr) {
          logEventIdFallback({
            phase: "failed",
            action: "typing",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
            reason: summarizeError(retryErr),
          });
          throw retryErr;
        }
      }
      return { channel: "qqbot" };
    } catch (err) {
      const message = summarizeError(err);
      return { channel: "qqbot", error: message };
    }
  },
};
