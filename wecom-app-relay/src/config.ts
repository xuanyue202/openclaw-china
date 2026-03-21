/**
 * Relay server 配置
 */
import { z } from "zod";
import { readFileSync } from "node:fs";

const AccountSchema = z.object({
  token: z.string(),
  encodingAESKey: z.string(),
  receiveId: z.string().default(""),
  corpId: z.string(),
  corpSecret: z.string(),
  agentId: z.number(),
  apiBaseUrl: z.string().default("https://qyapi.weixin.qq.com"),
  webhookPath: z.string().default("/wecom"),
});

const ConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().default(9080),
  authToken: z.string(),
  accounts: z.record(AccountSchema),
});

export type AccountConfig = z.infer<typeof AccountSchema>;
export type RelayConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): RelayConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return ConfigSchema.parse(raw);
}

export function loadConfigFromEnv(): RelayConfig | null {
  const token = process.env.RELAY_AUTH_TOKEN;
  const corpId = process.env.WECOM_CORP_ID;
  const corpSecret = process.env.WECOM_CORP_SECRET;
  const agentId = process.env.WECOM_AGENT_ID;
  const wecomToken = process.env.WECOM_TOKEN;
  const aesKey = process.env.WECOM_AES_KEY;

  if (!token || !corpId || !corpSecret || !agentId || !wecomToken || !aesKey) return null;

  return {
    host: process.env.RELAY_HOST ?? "0.0.0.0",
    port: parseInt(process.env.RELAY_PORT ?? "9080", 10),
    authToken: token,
    accounts: {
      default: {
        token: wecomToken,
        encodingAESKey: aesKey,
        receiveId: corpId,
        corpId,
        corpSecret,
        agentId: parseInt(agentId, 10),
        apiBaseUrl: process.env.WECOM_API_BASE_URL ?? "https://qyapi.weixin.qq.com",
        webhookPath: process.env.WECOM_WEBHOOK_PATH ?? "/wecom",
      },
    },
  };
}
