/**
 * 企微 API 调用（access token + 发消息）
 */

import type { AccountConfig } from "./config.js";

type TokenCache = { token: string; expiresAt: number };
const tokenCache = new Map<string, TokenCache>();

export async function getAccessToken(account: AccountConfig): Promise<string> {
  const key = `${account.corpId}:${account.agentId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const url = `${account.apiBaseUrl}/cgi-bin/gettoken?corpid=${account.corpId}&corpsecret=${account.corpSecret}`;
  const resp = await fetch(url);
  const data = (await resp.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`getAccessToken failed: ${data.errcode} ${data.errmsg}`);
  }
  if (!data.access_token) throw new Error("no access_token in response");

  const token = data.access_token;
  tokenCache.set(key, { token, expiresAt: Date.now() + ((data.expires_in ?? 7200) - 300) * 1000 });
  return token;
}

export async function sendTextMessage(
  account: AccountConfig,
  userId: string,
  text: string,
): Promise<{ ok: boolean; errcode?: number; errmsg?: string }> {
  const accessToken = await getAccessToken(account);
  const url = `${account.apiBaseUrl}/cgi-bin/message/send?access_token=${accessToken}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      touser: userId,
      msgtype: "text",
      agentid: account.agentId,
      text: { content: text },
    }),
  });

  const data = (await resp.json()) as { errcode?: number; errmsg?: string };
  return { ok: (data.errcode ?? 0) === 0, errcode: data.errcode, errmsg: data.errmsg };
}
